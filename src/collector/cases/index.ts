// collect-case dispatch table (BUILD_PLAN §8.1): one module per case family. Nothing here reads the
// spec's expected observations; every value is measured by the collector half of each case.
import type { CaseDef, PendingCase } from "../types.ts";
import { F1_A1, F1_A2 } from "./f1.ts";
import { F2_A1, F2_A2 } from "./f2.ts";
import { F3_A1, F3_A2, F3_A3 } from "./f3.ts";
import { F4_A1, F4_A2 } from "./f4.ts";
import { F5_A1, F5_A2 } from "./f5.ts";
import { S1 } from "./s1.ts";
import { S2 } from "./s2.ts";
import { S3 } from "./s3.ts";
import { F6 } from "./f6.ts";
import { SCENARIO_CASES } from "./scenarios.ts";

export const CASES: Record<string, CaseDef | PendingCase> = {
  "F1-A1": F1_A1, "F1-A2": F1_A2,
  "F2-A1": F2_A1, "F2-A2": F2_A2,
  "F3-A1": F3_A1, "F3-A2": F3_A2, "F3-A3": F3_A3,
  "F4-A1": F4_A1, "F4-A2": F4_A2,
  "F5-A1": F5_A1, "F5-A2": F5_A2,
  S1, S2, S3,
  ...F6,
  // Teaching-console scenarios (Task 6.1): not supplied evaluator cases.
  ...SCENARIO_CASES,
};
