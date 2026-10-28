import { defineConfig } from "vitest/config";

// Integration tests start real emulators and per-run Floci containers, so allow generous timeouts.
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 180_000 } });
