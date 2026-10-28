// The worker's only route to Slack. Emulate's /_slack/simulate/* routes accept any valid token, the worker's
// bot token included (LEARNINGS L-019), so the coordinator gives the worker this loopback proxy's URL instead
// of the emulator's. It forwards only the Web API methods the worker calls and answers 403 to everything else
// (/_slack/*, /_emulate/*, other /api methods, other HTTP verbs).
import { startFaultProxy } from "../faults/proxy.ts";

export const WORKER_SLACK_PATHS = ["/api/chat.postMessage"];

export async function startWorkerSlackProxy(port: number, upstream: string) {
  const proxy = await startFaultProxy(port, upstream);
  proxy.rules.push({ name: "not-a-worker-method", action: "http403", match: (r) => r.method !== "POST" || !WORKER_SLACK_PATHS.includes(r.url) });
  return proxy;
}
