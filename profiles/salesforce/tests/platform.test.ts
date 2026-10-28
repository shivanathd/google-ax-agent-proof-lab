// W03-SF platform tests (F5-R2). They run only against an owner-authorized, manifest-owned scratch org and are
// otherwise SKIPPED, which is never counted as PASS. Local-double results never substitute for these.
import { describe, expect, it } from "vitest";
import { salesforceAdapter } from "../index.ts";
import { activeScratchOrg, runPlatformTests } from "../lifecycle.ts";

const authorized = process.env.APL_SF_AUTHORIZE_RUN === "yes";
const org = authorized ? activeScratchOrg() : undefined;
const reason = !authorized
  ? "owner has not authorized the Salesforce lane (APL_SF_AUTHORIZE_RUN != yes)"
  : !org ? "no unexpired manifest-owned scratch org (run lifecycle.ts create/deploy first)" : "";

describe.skipIf(!org)(`W03-SF Salesforce platform${reason ? ` [SKIPPED: ${reason}]` : ""}`, () => {
  it("doctor prerequisites are satisfied", async () => {
    expect((await salesforceAdapter.doctor(process.env)).status).toBe("NOT_RUN");
  });

  it("permitted update, denied update and stale-version conflict all pass on the platform", () => {
    const outcomes = Object.fromEntries(runPlatformTests(org!, process.env).map((o) => [o.method, o.outcome]));
    expect(outcomes).toMatchObject({
      writerUpdatesWhenVersionMatches: "Pass",
      readOnlyPersonaIsDenied: "Pass",
      staleVersionConflictsWithoutOverwrite: "Pass",
    });
  });
});
