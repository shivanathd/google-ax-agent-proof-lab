// Collector-side clients and evidence bookkeeping. Runs only inside the separate collector process with its
// own credentials: a reader Slack token per workspace (channels:history/read → conversations.* only), its own
// S3/SQS clients and a read-only SQLite handle. Nothing here can write business state.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadBucketCommand } from "@aws-sdk/client-s3";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { guardAwsClient } from "../config/endpoints.ts";
import type { Endpoint } from "../config/run-config.ts";
import { slackClient } from "../adapters/slack/client.ts";
import { openReadOnly, rows, type Table } from "../ledger/read.ts";
import type { DB } from "../ledger/db.ts";

export type Fact = boolean | number | string;
export interface SlackTarget { tenant_id: string; installation_id: string; url: string; reader_token: string; channel_id: string; bot_user_id: string; users: Record<string, string> }
export interface CollectorConfig {
  case_id: string;
  output: string;            // absolute path of the C4 bundle the evaluator reads
  artifacts_dir: string;     // artifacts/runs/{run_id}/
  manifest_path: string;
  db_path?: string;
  slack: SlackTarget[];
  floci?: { endpoint: string; bucket: string; queue_url: string; credentials: { accessKeyId: string; secretAccessKey: string } };
  allowlist: Endpoint[];
  mutation: string;
  selected_profiles?: string[];
  needs?: { sinkhole?: boolean; shims?: boolean };
}

export class Probe {
  refs: Record<string, any> = {};
  observations: Record<string, Fact> = {};
  unobserved: Record<string, string> = {};
  evidence: { path: string; sha256: string; source: string; observations: string[] }[] = [];
  methods = new Set<string>();
  private captures = new Map<string, { ok: true; data: any } | { ok: false; error: string }>();
  private dbs = new Map<string, DB>();
  private s3?: S3Client;
  private sqs?: SQSClient;
  sinkhole?: { port: number; hits: { method: string; url: string; at: string }[] };
  shims?: { dir: string; log: string };

  constructor(public cfg: CollectorConfig, public evidenceDir: string) {
    mkdirSync(evidenceDir, { recursive: true });
    if (cfg.floci) {
      const c = { endpoint: cfg.floci.endpoint, region: "us-east-1", forcePathStyle: true, credentials: cfg.floci.credentials, maxAttempts: 1 };
      this.s3 = guardAwsClient(new S3Client(c), cfg.allowlist);
      this.sqs = guardAwsClient(new SQSClient(c), cfg.allowlist);
    }
  }

  // Records one evidence file. A failed capture is kept as a reason so dependent facts stay ABSENT.
  async capture<T>(name: string, source: string, fn: () => Promise<T> | T): Promise<T | undefined> {
    this.methods.add(source);
    try {
      const data = await fn();
      this.writeEvidence(name, source, data);
      this.captures.set(name, { ok: true, data });
      return data;
    } catch (e) {
      const error = `${(e as Error).name}: ${String((e as Error).message).slice(0, 160)}`;
      this.captures.set(name, { ok: false, error });
      return undefined;
    }
  }

  data<T = any>(name: string): T {
    const c = this.captures.get(name);
    if (!c?.ok) throw new Error(`capture ${name} unavailable`);
    return c.data as T;
  }

  // A fact exists only if every capture it depends on succeeded and the computed value is a typed scalar.
  fact(key: string, from: string[], fn: () => Fact) {
    const missing = from.filter((n) => !this.captures.get(n)?.ok);
    if (missing.length) {
      this.unobserved[key] = `not collected: ${missing.map((n) => `${n} (${(this.captures.get(n) as { error?: string } | undefined)?.error ?? "not captured"})`).join("; ")}`;
      return;
    }
    try {
      const v = fn();
      if (!["boolean", "number", "string"].includes(typeof v) || (typeof v === "number" && !Number.isFinite(v))) throw new Error("non-scalar observation");
      this.observations[key] = v;
      delete this.unobserved[key];
      for (const n of from) this.evidence.find((e) => e.path === `evidence/${n}.json`)!.observations.push(key);
    } catch (e) {
      this.unobserved[key] = `not computable: ${(e as Error).message}`;
    }
  }

  private writeEvidence(name: string, source: string, data: unknown) {
    const body = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(join(this.evidenceDir, `${name}.json`), body);
    const path = `evidence/${name}.json`;
    const existing = this.evidence.find((e) => e.path === path);
    if (existing) Object.assign(existing, { sha256: sha256(body), source });
    else this.evidence.push({ path, sha256: sha256(body), source, observations: [] });
  }

  // ---- Slack (reader token: conversations.* only) ----
  ws(tenant: string) {
    const t = this.cfg.slack.find((s) => s.tenant_id === tenant);
    if (!t) throw new Error(`no Slack target for ${tenant}`);
    return t;
  }
  async slack(tenant: string, method: "conversations.history" | "conversations.replies" | "conversations.list" | "auth.test", body: object = {}) {
    const t = this.ws(tenant);
    const r = await slackClient({ baseUrl: t.url, token: t.reader_token, allowlist: this.cfg.allowlist, timeoutMs: 5000 })(method, body);
    if (!r.ok) throw new Error(`slack ${method}: ${r.error}`);
    return r;
  }
  async replies(tenant: string, ts: string) {
    return ((await this.slack(tenant, "conversations.replies", { channel: this.ws(tenant).channel_id, ts })).messages ?? []) as Record<string, any>[];
  }
  async history(tenant: string) {
    return ((await this.slack(tenant, "conversations.history", { channel: this.ws(tenant).channel_id, limit: 200 })).messages ?? []) as Record<string, any>[];
  }

  // ---- Ledger (read-only connection, separate from the worker's) ----
  db(path = this.cfg.db_path): DB {
    if (!path) throw new Error("no ledger for this case");
    let db = this.dbs.get(path);
    if (!db) this.dbs.set(path, (db = openReadOnly(path)));
    return db;
  }
  rows(table: Table, where: Record<string, string | number> = {}, path?: string) {
    return rows(this.db(path), table, where);
  }

  // ---- Floci (collector's own S3/SQS clients) ----
  async s3Get(key: string): Promise<string | undefined> {
    if (!this.s3 || !this.cfg.floci) throw new Error("no S3 target");
    try {
      return await (await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.floci.bucket, Key: key }))).Body!.transformToString();
    } catch (e) {
      if ((e as Error).name === "NoSuchKey") return undefined;
      throw e;
    }
  }
  async s3Keys(): Promise<string[]> {
    if (!this.s3 || !this.cfg.floci) throw new Error("no S3 target");
    const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.cfg.floci.bucket }));
    return (r.Contents ?? []).map((o) => o.Key!).sort();
  }
  async s3Reachable() {
    if (!this.s3 || !this.cfg.floci) throw new Error("no S3 target");
    await this.s3.send(new HeadBucketCommand({ Bucket: this.cfg.floci.bucket }));
    return true;
  }
  async queueDepth() {
    if (!this.sqs || !this.cfg.floci) throw new Error("no SQS target");
    const r = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.cfg.floci.queue_url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    return { visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? NaN), in_flight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? NaN) };
  }

  close() {
    for (const db of this.dbs.values()) db.close();
    this.s3?.destroy();
    this.sqs?.destroy();
  }
}

// Shared W01 facts: ledger ticket, S3 object and Slack thread must agree (F3-A1, S1, S2, F4-A1).
export async function captureTicket(p: Probe, tag: string, tenant: string, ts: string) {
  const ledger = await p.capture(`${tag}-ledger`, "read-only SQLite query (tickets, inbox, actions)", () => {
    const inbox = p.rows("inbox", { message_ts: ts });
    const tickets = inbox.length ? p.rows("tickets", { inbox_id: inbox[0]!.id }) : [];
    const actions = tickets.flatMap((t) => p.rows("actions", { action_key: t.action_key }));
    return { inbox, tickets, actions };
  });
  const t = ledger?.tickets[0];
  await p.capture(`${tag}-s3`, "S3 GetObject (collector client, own credentials)", async () => {
    // G-UNKNOWN: without the ledger the receipt key is unknown, so "no receipt" would be an inferred zero.
    if (!ledger) throw new Error("ledger unavailable; receipt key unknown");
    const key = t?.receipt_key ?? (t ? `receipts/${t.tenant_id}/ticket-${t.id}.json` : undefined);
    if (!key) return { key: null, present: false, body: null };
    const body = await p.s3Get(key);
    return { key, present: body !== undefined, body: body ?? null };
  });
  await p.capture(`${tag}-thread`, "Slack conversations.replies (reader token)", () => p.replies(tenant, ts));
  const completion = (m: Record<string, any>) => m.bot_id && m.ts !== ts && t && String(m.text).includes(`Ticket #${t.id} created`);
  return {
    ticketCount: () => p.data(`${tag}-ledger`).tickets.length,
    receiptCount: () => (p.data(`${tag}-s3`).present ? 1 : 0),
    completionReplies: () => (p.data(`${tag}-thread`) as Record<string, any>[]).filter(completion),
    receiptMatches: () => {
      const { tickets, inbox, actions } = p.data(`${tag}-ledger`);
      const s3 = p.data(`${tag}-s3`);
      const tk = tickets[0];
      if (!tk || !s3.present) return false;
      const receipt = JSON.parse(s3.body);
      return sha256(s3.body) === tk.receipt_sha256 && receipt.subject_action_id === tk.action_id && actions.some((a: any) => a.action_id === tk.action_id) &&
        receipt.input_sha256 === sha256(canonical(receipt.input)) && receipt.input?.summary === tk.summary &&
        receipt.input?.requester_id === inbox[0]?.actor_id && receipt.tenant_id === tk.tenant_id;
    },
  };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Independent re-implementation of the receipt's canonical JSON (sorted keys), so the check does not reuse worker code.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
