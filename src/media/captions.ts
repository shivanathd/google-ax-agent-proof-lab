// Captions for README media and WebVTT cues for the MP4 clips, built only from committed data: the media
// manifest, each clip's sidecar marks and the sanitized run reports in docs/evidence/. `media optimize`
// calls `recaption()` last; `lab media captions --suite readme` re-runs it without re-encoding anything.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config/run-config.ts";
import { scenario } from "../reports/scenarios.ts";
import { EVIDENCE_DIR, MANIFEST, sha256File } from "./spec.ts";

export const MIN_CUE_MS = 1500;

export const CLIPS: Record<string, { shot: string; title: string; opening: string }> = {
  "clip-mental-model": { shot: "mental", title: "Mental model: the reply is not the acceptance test",
    opening: "Four layers kept apart: execution (where the work runs), emulation (what it talks to), authorization (what it may do) and evidence (what the independent collector can prove)." },
  "clip-duplicate-delivery": { shot: "w01d", title: "Duplicate delivery",
    opening: "Deliver the same signed event again. A second delivery must not become a second business action." },
  "clip-permission-boundary": { shot: "w02u", title: "Permission boundary",
    opening: "The requester cannot approve their own request. The action should fail without changing the record." },
  "clip-emulator-vs-real-org": { shot: "boundary", title: "Emulator versus real org",
    opening: "A local CRM contract double cannot prove Salesforce behaviour. That lane needs a real, separately authorized test org." },
};

const LEAD: Record<string, string> = {
  "lab-overview": "The teaching console after a real local run of the approval workflow.",
  "service-request-success": "A service request handled end to end: the reply is in the original thread and the collector found the ticket and the matching S3 receipt.",
  "approval-denied": "A self-approval and an ungranted approval click, both refused; the request record and receipts are unchanged.",
  "evidence-report": "The evidence report is the C5 report.json shown as written: expected and observed values, status and evidence file per assertion, plus limitations.",
  "profile-boundaries": "Optional lanes as their doctors report them on this machine: blocked lanes are not failures of the local demo and are not evidence of provider parity. AX reads BLOCKED here because no cluster is configured locally; its authorized cluster runs are reported in profiles/ax/RESULTS.md.",
  "slack-service-request": "The local scripted worker processes a synthetic request; the evaluator checks the ticket, receipt and reply thread.",
  "duplicate-event-safe": "Emulate re-delivers the same signed event; the collector compares before and after counts.",
  "approval-denied-gif": "Dana tries to approve her own request and Gus, who has no grant, tries too; both clicks are refused.",
};

const report = (root: string, runId: string) => JSON.parse(readFileSync(join(root, EVIDENCE_DIR, runId, "report.json"), "utf8"));
const observed = (r: any, failingOnly = false) =>
  r.assertions.filter((a: any) => !failingOnly || a.status !== "PASS").map((a: any) => `${a.id} ${JSON.stringify(a.observed)}`).join(", ");
const faults = (r: any) => (r.simulated_faults.length ? ` Injected fault: ${r.simulated_faults.join("; ")}.` : "");

// One run: lead, run, scenario, mode, revision, status and observed values. Several runs: each run and its
// outcome in the order shown, so a caption can never describe only the last run of a multi-run clip.
export function captionFor(lead: string, runIds: string[], revision: string, root = ROOT) {
  const rs = runIds.map((id) => report(root, id));
  const rev = `revision \`${revision.slice(0, 7)}\``;
  if (rs.length === 1) {
    const r = rs[0];
    return `${lead} Run \`${runIds[0]!.slice(0, 8)}\` (${r.case_id}, ${r.profile} profile, ${r.mode} mode, ${rev}): local core ${r.status}, ${r.counts.passed} of ${r.counts.required} required assertions passed; observed ${observed(r)}.${faults(r)} Synthetic data.`;
  }
  const parts = rs.map((r, i) => {
    const kind = r.simulated_faults.length ? "injected-fault run" : r.status === "PASS" ? "happy-path run" : "run";
    const tail = r.status === "PASS" ? "" : `, not a success (failing: ${observed(r, true)})`;
    return `${i === 0 ? "" : "then "}${kind} \`${runIds[i]!.slice(0, 8)}\` (${r.case_id}): local core ${r.status}, ${r.counts.passed} of ${r.counts.required} required assertions passed${tail}`;
  });
  return `${lead} Shown in order (${rs[0].profile} profile, ${rs[0].mode} mode, ${rev}): ${parts.join("; ")}.${rs.map(faults).join("")} The poster is a frame of the first run. Synthetic data.`;
}

export interface Cue { from: number; to: number; text: string }

// Cues from capture marks (ms from clip start). Marks closer than MIN_CUE_MS are merged into one cue, every
// cue lasts until the next one starts (so none overlap) and the last one ends with the clip.
export function cuesFor(marks: { t_ms: number; label: string }[], runIds: string[], opening: string, durationMs: number, root = ROOT): Cue[] {
  let reported = 0;
  const describe = (m: { label: string }): string | null => {
    if (m.label === "console loaded") return opening;
    if (m.label.startsWith("select ")) {
      const sc = scenario(m.label.slice(7));
      return sc ? `Scenario ${sc.id}: ${sc.title}. ${sc.summary}` : null;
    }
    if (m.label.startsWith("run clicked")) return "Run: an isolated stack starts (two Emulate Slack workspaces, a Floci container, the scripted worker) and the independent collector attaches.";
    if (m.label.startsWith("reported")) {
      const id = runIds[reported++];
      if (!id) return null;
      const r = report(root, id);
      return `Collector report for run ${id.slice(0, 8)} (${r.case_id}): ${r.banner.text}.${faults(r)}`;
    }
    if (m.label === "tab report") return "Evidence report: expected and observed values copied from report.json, with the evidence file behind each assertion.";
    if (m.label === "tab profiles") return "Optional lanes as reported by their doctors (local configuration only, no external calls); a blocked lane is not a pass.";
    if (m.label === "tab workflow") return "Back to the emulated Slack thread and the before/after state.";
    return null;
  };
  const raw = marks.map((m) => ({ t: Math.max(0, Math.min(m.t_ms, durationMs)), text: describe(m) })).filter((c): c is { t: number; text: string } => c.text !== null);
  const merged: { t: number; text: string }[] = [];
  for (const c of raw) {
    const last = merged.at(-1);
    if (last && c.t - last.t < MIN_CUE_MS) last.text += `\n${c.text}`;
    else merged.push({ ...c });
  }
  while (merged.length > 1 && durationMs - merged.at(-1)!.t < MIN_CUE_MS) merged.at(-2)!.text += `\n${merged.pop()!.text}`;
  return merged.map((c, i) => ({ from: c.t, to: merged[i + 1]?.t ?? durationMs, text: c.text }));
}

export function vtt(cues: Cue[]) {
  const ts = (ms: number) => new Date(Math.max(0, ms)).toISOString().slice(11, 23);
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${c.text}\n`).join("\n")}`;
}

export function parseVtt(text: string): Cue[] {
  const ms = (s: string) => {
    const [h, m, rest] = s.split(":");
    return (Number(h) * 3600 + Number(m) * 60 + Number(rest)) * 1000;
  };
  return [...text.matchAll(/(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})\n([^\n][\s\S]*?)(?=\n\n|\n*$)/g)].map((x) => ({ from: ms(x[1]!), to: ms(x[2]!), text: x[3]! }));
}

// Rewrites every manifest caption and every clip's .vtt (with fresh hashes) from committed data.
export function recaption(root = ROOT) {
  const file = join(root, MANIFEST);
  const m = JSON.parse(readFileSync(file, "utf8"));
  for (const e of m.media) {
    const runIds: string[] = e.run_ids ?? [e.run_id];
    if (e.mime_type !== "video/mp4") {
      e.caption = captionFor(LEAD[e.id]!, runIds, m.application_revision, root);
      continue;
    }
    const clip = CLIPS[e.id]!;
    e.caption = captionFor(`${clip.title} (MP4 clip, ${Math.round(e.duration_ms / 1000)} s, no audio; the captions are a separate WebVTT file, linked here, because a plain MP4 link does not load them).`, runIds, m.application_revision, root);
    const sidecar = JSON.parse(readFileSync(join(root, e.sidecar_path), "utf8"));
    const captions = e.path.replace(/\.mp4$/, ".vtt");
    writeFileSync(join(root, captions), vtt(cuesFor(sidecar.marks, runIds, clip.opening, e.duration_ms, root)));
    e.captions_path = captions;
    e.captions_sha256 = sha256File(join(root, captions));
  }
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
  return { manifest: MANIFEST, captions: m.media.filter((e: any) => e.captions_path && existsSync(join(root, e.captions_path))).map((e: any) => e.captions_path) };
}
