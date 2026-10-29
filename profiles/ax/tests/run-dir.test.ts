// Round trip: the writer (ownedResources, as index.ts run() calls it) -> owned-resources.json -> teardown.sh --dry-run,
// on a synthetic run dir with placeholder identifiers. Only --dry-run or refusal paths run, so no cluster or cloud
// call is possible; the fixture kubeconfig points at an .invalid host anyway.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../index.ts";
import { ownedResources, ownedResourcesErrors } from "../run-dir.ts";

const AX = join(import.meta.dirname, "..");
const TEARDOWN = join(AX, "teardown.sh");
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = "apl-fixture-context";
const hasKubectl = spawnSync("kubectl", ["version", "--client"], { env: { PATH: process.env.PATH ?? "", KUBECONFIG: "/dev/null" } }).status === 0;

function writerOutput() {
  const vars = {
    APL_RUN_ID: RUN_ID, APL_CASE_ID: "w01-h", APL_AX_IMAGE: `registry.example.invalid/lab@sha256:${"a".repeat(64)}`,
    APL_AX_ATESPACE: `apl-${RUN_ID}`, APL_FLOCI_IMAGE: "floci.example.invalid/floci@sha256:" + "b".repeat(64),
    APL_EMULATE_IMAGE: "emulate.example.invalid/emulate@sha256:" + "c".repeat(64), APL_SHORT_ID: RUN_ID.slice(0, 8),
    APL_LAB_IMAGE: "lab.example.invalid/lab@sha256:" + "d".repeat(64), APL_WORKER_IMAGE: "worker.example.invalid/w@sha256:" + "e".repeat(64),
  };
  const tpl = (p: string) => render(readFileSync(join(AX, "manifests", p), "utf8"), vars);
  return ownedResources({ runId: RUN_ID, kubeContext: CONTEXT, atespaces: [vars.APL_AX_ATESPACE], k8sYaml: tpl("k8s/emulators.yaml"), axYaml: tpl("ax/task.yaml"), axCli: "/opt/example/ax" });
}

function fixture(owned: unknown, context = CONTEXT) {
  const dir = mkdtempSync(join(tmpdir(), "apl-ax-rundir-"));
  writeFileSync(join(dir, "owned-resources.json"), JSON.stringify(owned, null, 2));
  writeFileSync(join(dir, "pre-snapshot.json"), JSON.stringify({ namespaces: [], scaled: {}, cluster_scoped: {} }));
  const kubeconfig = join(dir, "fixture-kubeconfig");
  writeFileSync(kubeconfig, JSON.stringify({
    apiVersion: "v1", kind: "Config", "current-context": context,
    clusters: [{ name: "c", cluster: { server: "https://kube.invalid" } }],
    users: [{ name: "u", user: { token: "fixture-not-a-token" } }],
    contexts: [{ name: context, context: { cluster: "c", user: "u" } }],
  }));
  return { dir, kubeconfig };
}

const teardown = (dir: string, kubeconfig: string, ...opts: string[]) =>
  spawnSync("bash", [TEARDOWN, dir, ...opts], { encoding: "utf8", env: { ...process.env, KUBECONFIG: kubeconfig } });

describe("ax run dir: writer and schema", () => {
  it("the writer's manifest lists every rendered object and validates", () => {
    const owned = writerOutput();
    expect(ownedResourcesErrors(owned)).toEqual([]);
    expect(owned.kube_context).toBe(CONTEXT);
    expect(owned.ax).toEqual([
      { kind: "workspace", atespace: `apl-${RUN_ID}`, name: `apl-ws-${RUN_ID}` },
      { kind: "task", atespace: `apl-${RUN_ID}`, name: `apl-task-${RUN_ID}` },
    ]);
    const ns = `apl-ax-${RUN_ID.slice(0, 8)}`;
    expect(owned.kubernetes).toEqual([
      { kind: "Namespace", name: ns },
      { kind: "Deployment", namespace: ns, name: "floci" },
      { kind: "Service", namespace: ns, name: "floci" },
      { kind: "Deployment", namespace: ns, name: "emulate" },
      { kind: "Service", namespace: ns, name: "emulate" },
      { kind: "NetworkPolicy", namespace: ns, name: "emulators-ingress" },
      { kind: "WorkerPool", namespace: ns, name: "apl-ax-pool" },
      { kind: "ServiceAccount", namespace: ns, name: "apl-collector" },
      { kind: "Pod", namespace: ns, name: "apl-collector" },
    ]);
  });

  it("rejects the layout the writer used to produce, and a missing kube_context", () => {
    const old = { run_id: RUN_ID, namespace: "apl-ax-00000000", label: `apl-run=${RUN_ID}`, atespace: `apl-${RUN_ID}`, ax: [`task/apl-task-${RUN_ID}`] };
    expect(ownedResourcesErrors(old).length).toBeGreaterThan(0);
    const { kube_context: _, ...noContext } = writerOutput();
    expect(ownedResourcesErrors(noContext)).toContain("/ must have required property 'kube_context'");
  });
});

describe.skipIf(!hasKubectl)("ax teardown.sh on a synthetic run dir", () => {
  it("--dry-run plans exactly the writer's objects in the recorded context", () => {
    const { dir, kubeconfig } = fixture(writerOutput());
    const r = teardown(dir, kubeconfig, "--dry-run");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const ns = `apl-ax-${RUN_ID.slice(0, 8)}`;
    expect(r.stdout).toContain("teardown: DRY RUN, nothing below is executed");
    expect(r.stdout).toMatch(new RegExp(`\\+ /opt/example/ax --server http://127.0.0.1:\\d+ delete task apl-task-${RUN_ID} -a apl-${RUN_ID}`));
    expect(r.stdout.indexOf(`delete task apl-task-${RUN_ID}`)).toBeLessThan(r.stdout.indexOf(`delete workspace apl-ws-${RUN_ID}`));
    expect(r.stdout).toContain(`+ kubectl ate delete atespace apl-${RUN_ID}`);
    expect(r.stdout).toContain(`+ kubectl -n ${ns} delete Deployment floci --ignore-not-found --wait=false`);
    expect(r.stdout).toContain(`+ kubectl delete namespace ${ns} --ignore-not-found --timeout=300s`);
    expect(r.stdout).not.toContain("gcloud"); // the writer records no cloud resources
  });

  it("refuses when the current kube context is not the recorded one", () => {
    const { dir, kubeconfig } = fixture(writerOutput(), "some-other-context");
    const r = teardown(dir, kubeconfig, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to act on another cluster");
    expect(r.stdout).not.toContain("+ ");
  });

  it("refuses a manifest that does not match the schema", () => {
    const { dir, kubeconfig } = fixture({ run_id: RUN_ID, namespace: "apl-ax-00000000", ax: [`task/apl-task-${RUN_ID}`] });
    const r = teardown(dir, kubeconfig, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match profiles/ax/run-dir.schema.json; refusing to act");
  });

  it("--restore-substrate-v05 needs --yes-clear-node-image-cache, and --dry-run warns and scopes the wipe by label", () => {
    const owned = {
      ...writerOutput(),
      project: "example-project",
      substrate_install: {
        repo: "https://git.example.invalid/substrate.git",
        current: { version: "v0.6.0", commit: "1".repeat(12), config: "/opt/example/current.yaml" },
        previous: { version: "v0.5.0", commit: "2".repeat(12), config: "/opt/example/previous.yaml", rollback_dir: "/opt/example/rollback" },
      },
      local: { ax_cli: "/opt/example/ax", bin: "/opt/example/bin", bin_v050: "/opt/example/bin-v050", docker_config: "/opt/example/docker" },
    };
    const { dir, kubeconfig } = fixture(owned);
    const refused = teardown(dir, kubeconfig, "--restore-substrate-v05");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("add --yes-clear-node-image-cache");
    expect(refused.stdout).toBe("");

    const r = teardown(dir, kubeconfig, "--restore-substrate-v05", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WARNING: deletes /var/lib/ate/image-cache on EVERY node");
    expect(r.stdout).toContain("--yes-clear-node-image-cache NOT given");
    const sel = `apl-run=${RUN_ID},apl-role=image-cache-wipe`;
    expect(r.stdout).toContain(`+ kubectl -n default wait pod -l ${sel}`);
    expect(r.stdout).toContain(`+ kubectl -n default delete pod -l ${sel} --wait=false`);
    expect(r.stdout).not.toContain("node-debugger");
    expect(r.stdout).not.toContain("kubectl debug");
  });

  it("--dry-run deletes an owned cluster and bucket with exactly the bucket's recorded bindings, never reused IAM", () => {
    const bucket = "gs://example-owned-bucket";
    const member = "serviceAccount:transfer@example-project.iam.example.invalid";
    const owned = {
      run_id: RUN_ID, kube_context: CONTEXT, project: "example-project", ax: [], substrate: [], kubernetes: [],
      cluster_scoped: [], scaled: [], scaled_namespaces: [],
      gke_cluster: { name: "example-cluster", location: "zone-a" }, gcs_buckets: [bucket],
      iam: [
        { kind: "iam-binding", resource_type: "bucket", resource: bucket, member, role: "roles/storage.objectAdmin" },
        { kind: "iam-binding", resource_type: "bucket", resource: bucket, member, role: "roles/storage.bucketViewer" },
      ],
    };
    expect(ownedResourcesErrors(owned)).toEqual([]);
    const { dir, kubeconfig } = fixture(owned);
    const r = teardown(dir, kubeconfig, "--dry-run");
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("+ gcloud"));
    expect(lines).toEqual([
      `+ gcloud storage buckets remove-iam-policy-binding ${bucket} --member=${member} --role=roles/storage.objectAdmin --project example-project`,
      `+ gcloud storage buckets remove-iam-policy-binding ${bucket} --member=${member} --role=roles/storage.bucketViewer --project example-project`,
      `+ gcloud storage rm --recursive ${bucket} --project example-project`,
      "+ gcloud container clusters delete example-cluster --location zone-a --project example-project",
      "+ gcloud compute disks delete <each disk in " + join(dir, "teardown-cluster-disks.txt") + "> --zone <its zone> --project example-project   (only those still present)",
    ]);
    expect(r.stdout).not.toContain("service-accounts");
  });
});
