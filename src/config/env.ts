// Child-process environments are built from an allowlist (F1-R3): ambient provider credentials never
// pass through, cloud metadata lookup is disabled and fake AWS credentials are injected. HOME is not
// passed through either: config dirs there (gcloud, kube, provider CLIs) must not be discoverable.
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PASS_THROUGH = ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "USER", "SHELL"];
const DOCKER_KEYS = /^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY)$/;

// Ambient variables that may carry provider identity; removed from this process at CLI start.
export const AMBIENT_CREDENTIAL = /^(AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|CLOUDSDK_|GCP_|SLACK_|SF_|SFDX_|SALESFORCE_|OPENAI_|ANTHROPIC_|GEMINI_|CODERABBIT_|GITHUB_TOKEN$|GH_TOKEN$|KUBECONFIG$)/;

export const FAKE_AWS = {
  AWS_ACCESS_KEY_ID: "lab-fake-access-key",
  AWS_SECRET_ACCESS_KEY: "lab-fake-secret-key",
  AWS_REGION: "us-east-1",
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_CONFIG_FILE: "/dev/null",
} as const;

export const FAKE_AWS_CREDENTIALS = { accessKeyId: FAKE_AWS.AWS_ACCESS_KEY_ID, secretAccessKey: FAKE_AWS.AWS_SECRET_ACCESS_KEY };

// HOME is the injected one (worker/collector pass a run-owned dir) or an empty lab-owned dir. Only a docker CLI
// child keeps the real HOME: Docker's context and credential store live there.
export function childEnv(ambient: NodeJS.ProcessEnv, inject: Record<string, string> = {}, opts: { docker?: boolean } = {}): Record<string, string> & typeof FAKE_AWS {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ambient)) {
    if (v === undefined) continue;
    if (PASS_THROUGH.includes(k) || (opts.docker && (DOCKER_KEYS.test(k) || k === "HOME"))) env[k] = v;
  }
  if (!opts.docker && !inject.HOME) env.HOME = emptyHome();
  return { ...env, ...FAKE_AWS, ...inject };
}
// Playwright locates Chromium under HOME; a process that drives a browser under a scoped HOME (only the collector)
// gets the real browser cache path explicitly. It is a path, not a config, and the worker never receives it.
export const browsersPath = (ambient: NodeJS.ProcessEnv) =>
  ambient.PLAYWRIGHT_BROWSERS_PATH ??
  join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
const emptyHome = () => {
  const dir = join(tmpdir(), "apl-empty-home");
  mkdirSync(dir, { recursive: true });
  return dir;
};

// Strip ambient credentials from the coordinator itself so in-process SDK clients cannot find them.
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter((k) => AMBIENT_CREDENTIAL.test(k) && !(k in FAKE_AWS));
  for (const k of removed) delete env[k];
  Object.assign(env, FAKE_AWS);
  return removed;
}
