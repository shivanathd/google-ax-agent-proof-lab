// Routes an accepted mention to its workflow using the scripted driver. Runs inside the inbox claim
// transaction, so plan, business writes and outbox rows commit together or not at all.
import { audit, finishInbox } from "../ledger/db.ts";
import { ContractError } from "../contracts/validate.ts";
import type { InboxRow } from "../worker/worker.ts";
import { denyRequest, reply, type Ctx } from "./context.ts";
import { DRIVER, plan } from "./scripted.ts";
import * as w01 from "./w01.ts";
import * as w02 from "./w02.ts";
import * as w03 from "./w03.ts";

export { w01, w02, w03 };

export function handleEvent(ctx: Ctx, row: InboxRow) {
  const p = plan(row.text);
  audit(ctx.db, row.run_id, row.tenant_id, "plan", { inbox_id: row.id, driver: DRIVER, workflow: p.workflow });
  try {
    switch (p.workflow) {
      case "W01": return w01.onRequest(ctx, row, p.summary);
      case "W02": return w02.onRequest(ctx, row, p);
      case "W02-edit": return w02.onEdit(ctx, row, p);
      case "W03": return w03.onRequest(ctx, row, p.fields);
      default:
        reply(ctx, row, `reply:help:${row.id}`, {
          channel: row.channel_id, thread_ts: row.thread_ts ?? row.message_ts,
          text: "Try: service-request <summary> | purchase-request <cents> <item> | crm-update account=\"<name>\" expected-version=<n> description=\"<text>\"",
        });
        return finishInbox(ctx.db, row.id, "done", "help");
    }
  } catch (e) {
    if (!(e instanceof ContractError)) throw e;
    return denyRequest(ctx, row, p.workflow, "invalid_input");
  }
}
