import { defineConfig } from "vitest/config";

// Runs the built bundle (npm run bundle first), with the Node that runs the tests.
export default defineConfig({ test: { include: ["test/smoke/*.smoke.ts"], testTimeout: 30_000 } });
