// The AX run-dir manifest, owned-resources.json, defined once in run-dir.schema.json. index.ts builds it with
// ownedResources() and writes it only if it validates; teardown.sh runs this file (`node run-dir.ts <file>`) and
// refuses to act when it does not. Errors name schema paths only, never values (the file holds identifiers).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

const schema = JSON.parse(readFileSync(new URL("./run-dir.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true, strictRequired: false, strictTypes: false }).compile(schema);

export function ownedResourcesErrors(value: unknown): string[] {
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

type K8sObject = { kind: string; name: string; namespace?: string };

// kind, metadata.name and metadata.namespace of each document in a rendered manifest. The lab templates keep
// metadata at two-space indent and use no other two-space `name:`/`namespace:` keys (checked by the round-trip test).
export function manifestObjects(yaml: string): K8sObject[] {
  return yaml.split(/^---$/m).flatMap((doc) => {
    const kind = /^kind: (\S+)$/m.exec(doc)?.[1];
    const name = /^ {2}name: (\S+)$/m.exec(doc)?.[1];
    if (!kind || !name) return [];
    const namespace = /^ {2}namespace: (\S+)$/m.exec(doc)?.[1];
    return [namespace ? { kind, namespace, name } : { kind, name }];
  });
}

// What one index.ts run() creates: the rendered Kubernetes objects, the AX Workspace + Task, and the atespace AX
// creates for them. Nothing is scaled and no cloud resource is created, so those sections stay empty or absent.
export function ownedResources(o: { runId: string; kubeContext: string; atespace: string; k8sYaml: string; axYaml: string; axCli: string }) {
  const value = {
    run_id: o.runId,
    short_id: o.runId.slice(0, 8),
    kube_context: o.kubeContext,
    ax: manifestObjects(o.axYaml).map((x) => ({ kind: x.kind.toLowerCase(), atespace: o.atespace, name: x.name })),
    substrate: [{ kind: "atespace", name: o.atespace, created_by: "ax apply" }],
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node profiles/ax/run-dir.ts <run-dir>/owned-resources.json");
  const errors = ownedResourcesErrors(JSON.parse(readFileSync(file, "utf8")));
  for (const e of errors) console.error(`run-dir: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
