// The AX run-dir manifest, owned-resources.json, defined once in run-dir.schema.json. The runner builds it with
// ownedResources() and recordOwned() and writes it only if it validates; teardown.sh runs this file (`node run-dir.ts <file>`) and
// refuses to act when it does not. Errors name schema paths only, never values (the file holds identifiers).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

const schema = JSON.parse(readFileSync(new URL("./run-dir.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true, strictRequired: false, strictTypes: false }).compile(schema);

export function ownedResourcesErrors(value: unknown): string[] {
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

type K8sObject = { kind: string; name: string; namespace?: string; atespace?: string };

// kind, metadata.name and metadata.namespace (or AX's metadata.atespace) of each document in a rendered manifest.
// A document is either a lab YAML template, which keeps metadata at two-space indent and uses no other two-space
// `name:`/`namespace:`/`atespace:` keys (checked by the round-trip test), or a JSON document as orchestrate.ts writes.
export function manifestObjects(yaml: string): K8sObject[] {
  return yaml.split(/^---$/m).flatMap((doc) => {
    const json = doc.trim().startsWith("{") ? JSON.parse(doc) : undefined;
    const field = (k: string): string | undefined => (json ? json.metadata?.[k] : new RegExp(`^ {2}${k}: (\\S+)$`, "m").exec(doc)?.[1]);
    const kind: string | undefined = json ? json.kind : /^kind: (\S+)$/m.exec(doc)?.[1];
    const name = field("name");
    if (!kind || !name) return [];
    const namespace = field("namespace"), atespace = field("atespace");
    return [{ kind, ...(namespace ? { namespace } : {}), name, ...(atespace ? { atespace } : {}) }];
  });
}

// What one run creates: the rendered Kubernetes objects, the AX Workspaces and Tasks, and the atespaces AX creates
// for them (one per tenant). Nothing is scaled and no cloud resource is created, so those sections stay empty or absent.
export function ownedResources(o: { runId: string; kubeContext: string; atespaces: string[]; k8sYaml: string; axYaml: string; axCli: string }) {
  const ax = manifestObjects(o.axYaml).map((x) => ({ kind: x.kind.toLowerCase(), atespace: x.atespace ?? "", name: x.name }));
  const stray = ax.find((x) => !o.atespaces.includes(x.atespace));
  if (stray) throw new Error(`AX ${stray.kind} ${stray.name} is not in one of the run's atespaces`);
  const value = {
    run_id: o.runId,
    short_id: o.runId.slice(0, 8),
    kube_context: o.kubeContext,
    ax,
    substrate: o.atespaces.map((name) => ({ kind: "atespace", name, created_by: "ax apply" })),
    kubernetes: manifestObjects(o.k8sYaml),
    cluster_scoped: [],
    scaled: [],
    scaled_namespaces: [],
    local: { ax_cli: o.axCli },
  };
  const errors = ownedResourcesErrors(value);
  if (errors.length) throw new Error(`owned-resources.json would not match run-dir.schema.json: ${errors.join("; ")}`);
  return value;
}

// Appends one entry to a section of <runDir>/owned-resources.json before its object is created (build plan §8.2).
// The whole file must still validate; it is replaced by a rename, so a crash leaves either the old or the new file.
export function recordOwned(runDir: string, section: string, entry: unknown) {
  updateOwned(runDir, `recordOwned: ${section} entry`, (value) => {
    value[section] = [...(value[section] ?? []), entry];
  });
}

// Sets removed_at on the open substrate row for one object, once a second listing no longer shows it (§4.3 step 6).
export function markRemoved(runDir: string, o: { kind: string; atespace: string; name: string }, at = new Date().toISOString()) {
  updateOwned(runDir, "markRemoved", (value) => {
    const row = (value.substrate ?? []).find((r: Record<string, string>) => r.kind === o.kind && r.atespace === o.atespace && r.name === o.name && !r.removed_at);
    if (!row) throw new Error(`markRemoved: no open substrate row for ${o.kind} ${o.name}`);
    row.removed_at = at;
  });
}

function updateOwned(runDir: string, what: string, change: (value: Record<string, any>) => void) {
  const file = join(runDir, "owned-resources.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  const errors = ownedResourcesErrors(value);
  if (errors.length) throw new Error(`${what} rejected by run-dir.schema.json: ${errors.join("; ")}`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node profiles/ax/run-dir.ts <run-dir>/owned-resources.json");
  const errors = ownedResourcesErrors(JSON.parse(readFileSync(file, "utf8")));
  for (const e of errors) console.error(`run-dir: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
