// Optional AX lane (F5-R4, F5-R6). doctor() reads local configuration only; run() always refuses, because cluster
// runs go through profiles/ax/multi.ts. AX never judges the outcome: the control plane does not read the command's
// exit status (L-006), so the independent collector decides.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { DoctorResult, Prerequisite, ProfileAdapter } from "../../src/contracts/profile.ts";

export const MIN_KUBECTL_MINOR = 35;
// Pinned in compose.yaml for the local lane; reused in-cluster so both lanes run the same emulator build.
export const FLOCI_IMAGE = "floci/floci:2.3.0@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9";
export const DIGEST_PINNED = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

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

// Design rule 9 (docs/MULTI_CLUSTER.md): one cluster driver. run() makes no call, not even doctor()'s kubectl probe.
export async function run(_caseId: string, _opts: { authorized: boolean; env: NodeJS.ProcessEnv }): Promise<DoctorResult> {
  return {
    profile: "ax",
    status: "BLOCKED",
    prerequisites: [],
    external_calls: 0,
    reason: "cluster runs go through profiles/ax/multi.ts (docs/MULTI_CLUSTER_BUILD.md)",
  };
}

export const axAdapter: ProfileAdapter = { name: "ax", doctor, run };
export default axAdapter;
