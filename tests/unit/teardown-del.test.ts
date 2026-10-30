// teardown.sh's del helper: a delete answered with gRPC NotFound (multi.ts already deleted the task after observing
// it) is "already gone", so the step is not marked INCOMPLETE; any other error still is "failed (continuing)".
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../src/config/run-config.ts";

const script = `
DRY=0
eval "$(sed -n '/^run() /p;/^# del </,/^}/p' "$1")"
nf() { echo 'Error: rpc error: code = NotFound desc = task "t" not found' >&2; return 1; }
other() { echo 'Error: rpc error: code = Unavailable desc = connection refused' >&2; return 1; }
del "ax delete task a" nf; del "ax delete task b" other; del "ax delete task c" true
del "kubectl ate delete atespace d" sh -c 'echo "sh: kubectl-ate: command not found" >&2; exit 127'
`;

it("treats only gRPC NotFound as already gone", () => {
  const r = spawnSync("bash", ["-c", script, "x", join(ROOT, "profiles/ax/teardown.sh")], { encoding: "utf8" });
  const lines = r.stdout.split("\n").filter((l) => l.startsWith("teardown:"));
  expect(lines).toEqual([
    "teardown: ax delete task a already gone",
    "teardown: ax delete task b failed (continuing)",
    "teardown: kubectl ate delete atespace d failed (continuing)",
  ]);
});
