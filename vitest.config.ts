import { configDefaults, defineConfig } from "vitest/config";

// Integration tests start real emulators and per-run Floci containers, so allow generous timeouts.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".claude/**"], testTimeout: 180_000, hookTimeout: 180_000 } });
