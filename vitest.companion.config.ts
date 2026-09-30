import { defineConfig } from "vitest/config";

// Companion tests spawn the built executable against a fresh home folder, where the Copilot CLI
// unpacks its runtime (about 138 MB) before the companion can greet Chrome. That has taken over
// 15 seconds on CI's Intel runners, so a test needs room for it plus the install or package work
// around it. See the note on startupTimeout in tests/companion/companion.test.ts.
export default defineConfig({
  test: { include: ["tests/companion/**/*.test.ts"], testTimeout: 120_000 },
});
