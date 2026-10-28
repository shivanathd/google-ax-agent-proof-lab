// Optional AX lane (F5-R4, F5-R6). doctor() reads local configuration only; run() refuses unless every
// prerequisite holds AND the operator passed authorized=true. AX never judges the outcome: the control plane
// does not read the command's exit status (L-006), so run() stops at UNKNOWN and the independent collector decides.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorResult, Prerequisite, ProfileAdapter } from "../../src/contracts/profile.ts";
import { ownedResources } from "./run-dir.ts";

export const MIN_KUBECTL_MINOR = 35;
// Pinned in compose.yaml for the local lane; reused in-cluster so both lanes run the same emulator build.
export const FLOCI_IMAGE = "floci/floci:2.3.0@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9";
const DIGEST_PINNED = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const RFC1123 = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const MANIFESTS = join(dirname(fileURLToPath(import.meta.url)), "manifests");

// Runs only when APL_AX_KUBECTL names a binary. KUBECONFIG=/dev/null makes a server call impossible.
function kubectlClientMinor(bin: string): number | null {
  try {
    const out = execFileSync(bin, ["version", "--client", "-o", "json"], {
      env: { PATH: process.env.PATH ?? "", KUBECONFIG: "/dev/null" },
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const minor = Number.parseInt(JSON.parse(out.toString()).clientVersion?.minor ?? "", 10);
    return Number.isFinite(minor) ? minor : null;
  } catch {
    return null;
  }
}

export function prerequisites(env: NodeJS.ProcessEnv): Prerequisite[] {
  const kubectl = env.APL_AX_KUBECTL;
  const minor = kubectl ? kubectlClientMinor(kubectl) : null;
  const image = env.APL_AX_IMAGE ?? "";
  return [
    {
      id: "ax.kubectl",
      description: kubectl
        ? `APL_AX_KUBECTL must be a kubectl client >= 1.${MIN_KUBECTL_MINOR}; found ${minor === null ? "no readable client version" : `1.${minor}`}`
        : `Set APL_AX_KUBECTL to a separately installed kubectl client >= 1.${MIN_KUBECTL_MINOR} (the host kubectl is 1.34, which is too old)`,
      satisfied: minor !== null && minor >= MIN_KUBECTL_MINOR,
    },
    {
      id: "ax.kube-context",
      description: "Set APL_AX_CONTEXT to the kube context name of the owner-approved cluster (never the ambient current-context)",
      satisfied: Boolean(env.APL_AX_CONTEXT),
    },
    {
      id: "ax.image",
      description: "Set APL_AX_IMAGE to the runner image pinned by digest (repo@sha256:...); Substrate rejects tag-only references",
      satisfied: DIGEST_PINNED.test(image),
    },
    {
      id: "ax.cli",
      description: "Set APL_AX_CLI to the ax CLI binary; AX Task/Workspace are applied with `ax apply`, not kubectl",
      satisfied: Boolean(env.APL_AX_CLI) && existsSync(env.APL_AX_CLI!),
    },
    {
      id: "ax.substrate-api",
      description:
        "Set APL_AX_SUBSTRATE_API to the expected in-cluster Substrate Control API (upstream default api.ate-system.svc.cluster.local:443); run() re-checks it with `kubectl get svc api -n ate-system`",
      satisfied: Boolean(env.APL_AX_SUBSTRATE_API),
    },
    {
      id: "ax.authorized",
      description: "Set APL_AX_AUTHORIZED=1 only after the owner approves a cluster run for this session",
      satisfied: env.APL_AX_AUTHORIZED === "1",
    },
  ];
}

export async function doctor(env: NodeJS.ProcessEnv): Promise<DoctorResult> {
  const prereqs = prerequisites(env);
  const missing = prereqs.filter((p) => !p.satisfied).map((p) => p.id);
  return {
    profile: "ax",
    status: missing.length ? "BLOCKED" : "NOT_RUN",
    prerequisites: prereqs,
    external_calls: 0,
    reason: missing.length
      ? `AX lane blocked; unsatisfied: ${missing.join(", ")}`
      : "All AX prerequisites are declared; nothing has run yet",
  };
}

// Replaces ${APL_*} placeholders; an unknown placeholder is an error, never an empty string.
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(APL_[A-Z0-9_]+)\}/g, (_, k: string) => {
    if (vars[k] === undefined) throw new Error(`manifest placeholder ${k} has no value`);
    return vars[k];
  });
}

export async function run(caseId: string, opts: { authorized: boolean; env: NodeJS.ProcessEnv }): Promise<DoctorResult> {
  const d = await doctor(opts.env);
  if (d.status === "BLOCKED" || !opts.authorized) {
    return {
      ...d,
      status: "BLOCKED",
      reason: opts.authorized ? d.reason : `Refused: run requires the explicit authorized=true opt-in. ${d.reason}`,
    };
  }
  if (!RFC1123.test(caseId)) throw new Error(`case id ${caseId} is not an RFC 1123 label`);

  // Authorized path. Never executed by tests; first exercised in W6 after owner approval.
  const env = opts.env;
  const runId = randomUUID();
  const vars: Record<string, string> = {
    APL_RUN_ID: runId,
    APL_CASE_ID: caseId,
    APL_AX_IMAGE: env.APL_AX_IMAGE!,
    APL_AX_ATESPACE: `apl-${runId}`,
    APL_FLOCI_IMAGE: env.APL_FLOCI_IMAGE ?? FLOCI_IMAGE,
    APL_EMULATE_IMAGE: env.APL_EMULATE_IMAGE ?? "",
    APL_SHORT_ID: runId.slice(0, 8),
    APL_LAB_IMAGE: env.APL_AX_IMAGE!,
    APL_WORKER_IMAGE: env.APL_AX_WORKER_IMAGE ?? "",
  };
  if (!DIGEST_PINNED.test(vars.APL_EMULATE_IMAGE!)) throw new Error("APL_EMULATE_IMAGE must be pinned by digest");
  const outDir = join("private-runs", "ax", runId);
  mkdirSync(outDir, { recursive: true });
  const k8s = join(outDir, "emulators.yaml");
  const ax = join(outDir, "task.yaml");
  writeFileSync(k8s, render(readFileSync(join(MANIFESTS, "k8s", "emulators.yaml"), "utf8"), vars));
  writeFileSync(ax, render(readFileSync(join(MANIFESTS, "ax", "task.yaml"), "utf8"), vars));

  const ctx = env.APL_AX_CONTEXT!;
  // Recorded before anything is applied, so teardown.sh can clean up a run that fails half way.
  const owned = ownedResources({ runId, kubeContext: ctx, atespace: vars.APL_AX_ATESPACE!, k8sYaml: readFileSync(k8s, "utf8"), axYaml: readFileSync(ax, "utf8"), axCli: env.APL_AX_CLI! });
  writeFileSync(join(outDir, "owned-resources.json"), JSON.stringify(owned, null, 2));
  // Single-context kubeconfig (mode 0600, gitignored run dir): its current-context is the one teardown.sh checks.
  const kubeconfig = join(outDir, "kubeconfig");
  writeFileSync(kubeconfig, execFileSync(env.APL_AX_KUBECTL!, ["config", "view", "--minify", "--flatten", "--context", ctx]), { mode: 0o600 });
  let calls = 0;
  const remote = (bin: string, ...args: string[]) => {
    calls++;
    execFileSync(bin, ["--context", ctx, ...args], { stdio: "inherit" });
  };
  remote(env.APL_AX_KUBECTL!, "get", "svc", "api", "-n", "ate-system");
  calls++;
  execFileSync(join(dirname(fileURLToPath(import.meta.url)), "teardown.sh"), ["--snapshot", outDir, join(outDir, "pre-snapshot.json")], { stdio: "inherit", env: { ...env, KUBECONFIG: kubeconfig } });
  remote(env.APL_AX_KUBECTL!, "apply", "-f", k8s);
  remote(env.APL_AX_KUBECTL!, "wait", "-n", `apl-ax-${vars.APL_SHORT_ID}`, "--for=condition=Available", "deployment", "-l", `apl-run=${runId}`, "--timeout=180s");
  remote(env.APL_AX_CLI!, "apply", "-a", vars.APL_AX_ATESPACE!, "-f", ax);
  return {
    ...d,
    status: "UNKNOWN",
    external_calls: calls,
    reason: `Applied run ${runId}. Outcome is UNKNOWN until the independent collector reads /apl/result and the emulators; AX task phase is not evidence (L-006).`,
  };
}

export const axAdapter: ProfileAdapter = { name: "ax", doctor, run };
export default axAdapter;
