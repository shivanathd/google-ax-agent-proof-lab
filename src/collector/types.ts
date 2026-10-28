// One case = a coordinator half (`execute`: set up and drive the real stack) and a collector half
// (`phases`/`observe`: independent facts, run in the separate collector process).
import type { RunHandle, WorkerOptions } from "../config/lifecycle.ts";
import type { Probe } from "./probe.ts";

export interface CollectorInfo { sinkhole_port?: number; shim_dir?: string }

export interface Exec {
  h: RunHandle;
  info: CollectorInfo;
  scratch: string;                          // coordinator-owned temp directory for this case
  ref: (key: string, value: unknown) => void; // stimulus identity passed to the collector (never expectations)
  fault: (description: string) => void;     // labels a simulated fault in the bundle and report
  snapshot: (phase: string) => Promise<void>;
  defer: (fn: () => Promise<void> | void) => void; // coordinator cleanup run after the collector finishes
}

export interface CaseDef {
  stack?: { floci?: boolean; slack?: boolean; extraPorts?: string[] };
  needs?: { sinkhole?: boolean; shims?: boolean };
  worker?: false | ((h: RunHandle, info: CollectorInfo) => WorkerOptions);
  selected_profiles?: string[];
  prerequisite?: () => string | undefined;  // unmet → bundle execution NOT_RUN with this reason; nothing is started
  execute: (x: Exec) => Promise<void>;
  phases?: Record<string, (p: Probe) => Promise<void>>;
  observe: (p: Probe) => Promise<void>;
}

// Registered but not implementable yet: the harness must see BLOCKED (exit 2), never FAIL or PASS.
export interface PendingCase { pending: string }
