// Worker process entry. Started by the coordinator with an allowlisted env (src/worker/config.ts).
// Prints one JSON line {"ready":true} once the Slack receiver is listening on loopback.
import { openLedger } from "../ledger/db.ts";
import { buildSlackApp } from "../http/slack.ts";
import { createWorker } from "./worker.ts";
import type { WorkerConfig } from "./config.ts";

const cfg = JSON.parse(process.env.APL_WORKER ?? "null") as WorkerConfig | null;
if (!cfg) {
  console.error("worker: APL_WORKER config missing");
  process.exit(1);
}
const db = openLedger(cfg.db_path);
const worker = await createWorker(cfg, db);
const app = buildSlackApp({ runId: cfg.run_id, db, installations: cfg.installations, onAccepted: worker.onAccepted, onBlockAction: worker.onBlockAction });
await app.listen({ host: "127.0.0.1", port: cfg.http_port });
await worker.start(); // recover anything accepted or committed-but-unfinished before a restart
console.log(JSON.stringify({ ready: true, pid: process.pid }));

const stop = async () => {
  worker.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
