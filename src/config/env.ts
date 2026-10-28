// Child-process environments are built from an allowlist (F1-R3): ambient provider credentials never
// pass through, cloud metadata lookup is disabled and fake AWS credentials are injected.
const PASS_THROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "USER", "SHELL"];
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

export function childEnv(ambient: NodeJS.ProcessEnv, inject: Record<string, string> = {}, opts: { docker?: boolean } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ambient)) {
    if (v === undefined) continue;
    if (PASS_THROUGH.includes(k) || (opts.docker && DOCKER_KEYS.test(k))) env[k] = v;
  }
  return { ...env, ...FAKE_AWS, ...inject };
}

// Strip ambient credentials from the coordinator itself so in-process SDK clients cannot find them.
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter((k) => AMBIENT_CREDENTIAL.test(k) && !(k in FAKE_AWS));
  for (const k of removed) delete env[k];
  Object.assign(env, FAKE_AWS);
  return removed;
}
