// F6 and S4 belong to the console/media task (6.1). Registered so the harness reports BLOCKED, never FAIL or PASS.
import type { PendingCase } from "../types.ts";

const pending: PendingCase = { pending: "console/media not built yet (Task 6.1); no execution evidence collected" };
export const F6 = { "F6-A1": pending, "F6-A2": pending, "F6-A3": pending, "F6-A4": pending, "F6-A5": pending, S4: pending };
