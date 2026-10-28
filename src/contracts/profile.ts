// Shared contract between the CLI and every optional profile adapter (F1-R6, F5-R1..R6).
// Status vocabulary follows C5; an adapter never returns PASS without executed evidence.
export type ProfileName = "local" | "salesforce" | "coderabbit" | "ax" | "live-model";
export type LaneStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "NOT_RUN" | "UNKNOWN";

export interface Prerequisite {
  id: string;            // stable key, e.g. "sf.devhub-alias"
  description: string;   // what the owner must provide; never a secret value
  satisfied: boolean;
}

export interface DoctorResult {
  profile: ProfileName;
  status: LaneStatus;              // BLOCKED when any prerequisite is unsatisfied
  prerequisites: Prerequisite[];
  external_calls: number;          // doctor must make zero external calls
  reason: string;
}

export interface ProfileAdapter {
  name: Exclude<ProfileName, "local">;
  // Inspect local configuration only; must not contact a provider.
  doctor(env: NodeJS.ProcessEnv): Promise<DoctorResult>;
  // Run a case only when doctor is satisfied AND `authorized` is the explicit operator opt-in (F5-R6).
  run(caseId: string, opts: { authorized: boolean; env: NodeJS.ProcessEnv }): Promise<DoctorResult>;
}
