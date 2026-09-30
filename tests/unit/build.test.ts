import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companionBuildDirectory, runBuilder, UNINSTALL_SCRIPT } from "../../src/companion/build.ts";
import { COMPANION_EXECUTABLE_NAME, UNINSTALL_SCRIPT_NAME } from "../../src/companion/layout.ts";

const buildCliPath = fileURLToPath(new URL("../../src/companion/build-cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
let messages: { log: string[]; error: string[] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "companion-build-"));
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("companion layout", () => {
  it("keeps each architecture's build apart in dist-companion", () => {
    expect(companionBuildDirectory("arm64")).toBe(join(repositoryRoot, "dist-companion", "darwin-arm64"));
    expect(companionBuildDirectory("x64")).toBe(join(repositoryRoot, "dist-companion", "darwin-x64"));
  });
});

describe("uninstall script", () => {
  it("runs the companion beside it with --uninstall, passing its options on, from any folder", () => {
    const companionDirectory = join(root, "Application Support", "companion");
    mkdirSync(companionDirectory, { recursive: true });
    writeFileSync(join(companionDirectory, UNINSTALL_SCRIPT_NAME), UNINSTALL_SCRIPT);
    writeFileSync(join(companionDirectory, COMPANION_EXECUTABLE_NAME), '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(join(companionDirectory, UNINSTALL_SCRIPT_NAME), 0o755);
    chmodSync(join(companionDirectory, COMPANION_EXECUTABLE_NAME), 0o755);

    const { status, stdout } = spawnSync(join(companionDirectory, UNINSTALL_SCRIPT_NAME), ["--keep-saved-pat"], { cwd: root, encoding: "utf8" });
    expect(status).toBe(0);
    expect(stdout).toBe("--uninstall|--keep-saved-pat|");
  });
});

// On macOS, tests/companion checks what a real build produces.
describe("runBuilder", () => {
  it.each([
    ["outside macOS", { platform: "linux" as const }, /macOS only/],
    ["for a Mac architecture the Copilot SDK does not support", { arch: "ia32" }, /arm64.*x64.*not ia32/],
  ])("refuses to build %s without creating anything", async (_description, overrides, message) => {
    const outputDirectory = join(root, "dist-companion", "darwin-arm64");
    await expect(
      runBuilder({
        platform: "darwin",
        arch: "arm64",
        outputDirectory,
        output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
        ...overrides,
      }),
    ).resolves.toBe(1);
    expect(messages.error.join("\n")).toMatch(message);
    expect(existsSync(join(root, "dist-companion"))).toBe(false);
  });

  it.skipIf(process.platform === "darwin")("refuses to build from the command line outside macOS", () => {
    const refused = spawnSync(process.execPath, [buildCliPath], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/macOS only/);
  });
});
