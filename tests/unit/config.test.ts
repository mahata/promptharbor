import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompanionConfig, resolveCopilotCli, writeCompanionConfig } from "../../src/companion/config.ts";
import { describeCopilotRuntime } from "../../src/companion/runtime.ts";

const HOME = "/Users/octocat";
const CHROME_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const HOMEBREW_CLI = "/opt/homebrew/bin/copilot";

let root: string;
let configPath: string;

function found(...paths: string[]) {
  const executables = new Set(paths);
  return async (path: string) => executables.has(path);
}

function options(overrides: Partial<Parameters<typeof resolveCopilotCli>[0]> = {}) {
  return { configPath, home: HOME, pathVariable: CHROME_PATH, override: undefined, isExecutable: found(), ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "companion-config-"));
  configPath = join(root, "config.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readCompanionConfig", () => {
  it("reads a recorded Copilot CLI path", async () => {
    writeFileSync(configPath, JSON.stringify({ copilotCliPath: HOMEBREW_CLI }));

    await expect(readCompanionConfig(configPath)).resolves.toEqual({ copilotCliPath: HOMEBREW_CLI });
  });

  it.each([
    ["no file at all", undefined],
    ["a file that is not JSON", "not json"],
    ["a JSON array", "[]"],
    ["a relative path, which is not safe to run", JSON.stringify({ copilotCliPath: "copilot" })],
    ["a path that is not a string", JSON.stringify({ copilotCliPath: 7 })],
  ])("reports nothing for %s", async (_label, contents) => {
    if (contents !== undefined) writeFileSync(configPath, contents);

    await expect(readCompanionConfig(configPath)).resolves.toEqual({});
  });
});

describe("writeCompanionConfig", () => {
  it("writes a config the reader accepts, creating the folder it belongs in", async () => {
    const nestedPath = join(root, "nested", "config.json");

    await expect(writeCompanionConfig(nestedPath, { copilotCliPath: HOMEBREW_CLI })).resolves.toBe(true);
    await expect(readCompanionConfig(nestedPath)).resolves.toEqual({ copilotCliPath: HOMEBREW_CLI });
  });

  it("replaces an earlier config", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: "/usr/local/bin/copilot" });
    await writeCompanionConfig(configPath, { copilotCliPath: HOMEBREW_CLI });

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ copilotCliPath: HOMEBREW_CLI });
  });

  it("reports failure rather than throwing when it cannot write", async () => {
    await expect(writeCompanionConfig(join(root, "missing\0name"), {})).resolves.toBe(false);
  });
});

describe("resolveCopilotCli", () => {
  it("uses the recorded path without searching", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: HOMEBREW_CLI });

    await expect(resolveCopilotCli(options({ isExecutable: found(HOMEBREW_CLI) }))).resolves.toEqual({
      path: HOMEBREW_CLI,
      recorded: HOMEBREW_CLI,
    });
  });

  it("searches again when the recorded path has gone", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: "/gone/copilot" });

    await expect(resolveCopilotCli(options({ isExecutable: found(HOMEBREW_CLI) }))).resolves.toEqual({
      path: HOMEBREW_CLI,
      recorded: "/gone/copilot",
    });
  });

  it("searches when nothing is recorded yet, as after an install that found no Copilot CLI", async () => {
    await expect(resolveCopilotCli(options({ isExecutable: found(HOMEBREW_CLI) }))).resolves.toEqual({
      path: HOMEBREW_CLI,
      recorded: undefined,
    });
  });

  it("reports nothing when no Copilot CLI is installed", async () => {
    await expect(resolveCopilotCli(options())).resolves.toEqual({ path: undefined, recorded: undefined });
  });

  it("leaves the recorded path alone, so only the installer ever rewrites it", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: "/gone/copilot" });
    await resolveCopilotCli(options({ isExecutable: found(HOMEBREW_CLI) }));

    await expect(readCompanionConfig(configPath)).resolves.toEqual({ copilotCliPath: "/gone/copilot" });
  });

  it("lets a pinned path win over the recorded one", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: HOMEBREW_CLI });
    const pinned = "/opt/pinned/copilot";

    await expect(
      resolveCopilotCli(options({ override: pinned, isExecutable: found(pinned, HOMEBREW_CLI) })),
    ).resolves.toEqual({ path: pinned, recorded: HOMEBREW_CLI });
  });

  it("reports nothing when a pinned path has gone, even with a usable recorded one", async () => {
    await writeCompanionConfig(configPath, { copilotCliPath: HOMEBREW_CLI });

    await expect(
      resolveCopilotCli(options({ override: "/opt/pinned/copilot", isExecutable: found(HOMEBREW_CLI) })),
    ).resolves.toEqual({ path: undefined, recorded: HOMEBREW_CLI });
  });
});

describe("describeCopilotRuntime", () => {
  function runtimeOptions(overrides: Partial<Parameters<typeof describeCopilotRuntime>[0]> = {}) {
    return { ...options(), runVersion: async () => "", ...overrides };
  }

  it("is ready when the Copilot CLI it found is new enough", async () => {
    await expect(
      describeCopilotRuntime(
        runtimeOptions({ isExecutable: found(HOMEBREW_CLI), runVersion: async () => "GitHub Copilot CLI 1.0.89-3.\n" }),
      ),
    ).resolves.toEqual({ state: "ready", path: HOMEBREW_CLI, version: "1.0.89-3" });
  });

  it("is missing when no Copilot CLI is installed", async () => {
    await expect(describeCopilotRuntime(runtimeOptions())).resolves.toEqual({ state: "missing" });
  });

  it("is unsupported when what it found does not answer like the Copilot CLI", async () => {
    await expect(
      describeCopilotRuntime(runtimeOptions({ isExecutable: found(HOMEBREW_CLI), runVersion: async () => "some other tool 4.2\n" })),
    ).resolves.toEqual({ state: "unsupported", path: HOMEBREW_CLI });
  });

  // Homebrew's cask installs 1.0.83, older than the version the SDK bundles. Guessing a floor from
  // the SDK's own build target rejected it, so no version floor is applied: the SDK's protocol
  // handshake decides, and reports runtime_unsupported at connect if it cannot agree one.
  it("is ready for a Copilot CLI older than the version the SDK was built against", async () => {
    await expect(
      describeCopilotRuntime(
        runtimeOptions({ isExecutable: found(HOMEBREW_CLI), runVersion: async () => "GitHub Copilot CLI 1.0.83.\n" }),
      ),
    ).resolves.toEqual({ state: "ready", path: HOMEBREW_CLI, version: "1.0.83" });
  });
});
