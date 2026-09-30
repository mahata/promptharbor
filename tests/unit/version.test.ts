import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createVersionRunner,
  isSupportedCopilotCliVersion,
  MINIMUM_COPILOT_CLI_VERSION,
  parseCopilotCliVersion,
  readCopilotCliVersion,
} from "../../src/companion/version.ts";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("compareVersions", () => {
  it.each([
    ["13.5", "13.5", 0],
    ["13.5", "13.5.0", 0],
    ["14.0", "13.5", 1],
    ["13.10", "13.9", 1],
    ["11.0", "13.5", -1],
    ["13.5.1", "13.5", 1],
  ])("compares %s with %s as %i", (first, second, expected) => {
    expect(compareVersions(first, second)).toBe(expected);
  });

  it.each([
    ["1.0.89-3", "1.0.89", 1],
    ["1.0.89-3", "1.0.89-3", 0],
    ["1.0.89-2", "1.0.89-3", -1],
    ["1.0.89", "1.0.85", 1],
  ])("orders the Copilot CLI's prerelease suffix, comparing %s with %s as %i", (first, second, expected) => {
    expect(compareVersions(first, second)).toBe(expected);
  });
});

describe("parseCopilotCliVersion", () => {
  it("reads the version out of what the Copilot CLI prints, ignoring the update notice", () => {
    expect(parseCopilotCliVersion("GitHub Copilot CLI 1.0.89-3.\nRun 'copilot update' to check for updates.\n")).toBe("1.0.89-3");
  });

  it("reads a version without a prerelease suffix", () => {
    expect(parseCopilotCliVersion("GitHub Copilot CLI 1.0.85.\n")).toBe("1.0.85");
  });

  it.each([["", "no output"], ["bash: copilot: command not found\n", "a shell error"], ["git version 2.51.0\n", "another tool"]])(
    "returns nothing for %j, which is %s",
    (output) => {
      expect(parseCopilotCliVersion(output)).toBeUndefined();
    },
  );
});

describe("isSupportedCopilotCliVersion", () => {
  it("accepts the version the SDK was built against", () => {
    expect(isSupportedCopilotCliVersion(MINIMUM_COPILOT_CLI_VERSION)).toBe(true);
  });

  it("accepts a newer Copilot CLI, which is what an auto-updating install becomes", () => {
    expect(isSupportedCopilotCliVersion("1.0.89-3")).toBe(true);
  });

  it("refuses one older than the SDK was built against", () => {
    expect(isSupportedCopilotCliVersion("1.0.84")).toBe(false);
  });
});

describe("readCopilotCliVersion", () => {
  it("reports the version the Copilot CLI printed", async () => {
    await expect(readCopilotCliVersion("/bin/copilot", async () => "GitHub Copilot CLI 1.0.90.\n")).resolves.toBe("1.0.90");
  });

  it("reports nothing when the executable cannot be run", async () => {
    await expect(
      readCopilotCliVersion("/bin/copilot", () => Promise.reject(new Error("spawn failed"))),
    ).resolves.toBeUndefined();
  });

  it("reports nothing when the executable is not the Copilot CLI", async () => {
    await expect(readCopilotCliVersion("/bin/copilot", async () => "some other tool 4.2\n")).resolves.toBeUndefined();
  });
});

describe("createVersionRunner", () => {
  it("gives the Copilot CLI the cache directory as HOME, so it unpacks there and not in the real one", async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), "version-cache-"));
    const cliDirectory = mkdtempSync(join(tmpdir(), "version-cli-"));
    try {
      const executablePath = join(cliDirectory, "copilot");
      writeFileSync(executablePath, "#!/bin/sh\nprintf 'GitHub Copilot CLI 1.0.99.\\n'\nmkdir -p \"$HOME/unpacked\"\n");
      chmodSync(executablePath, 0o755);

      await expect(readCopilotCliVersion(executablePath, createVersionRunner(cacheDirectory))).resolves.toBe("1.0.99");
      expect(readdirSync(cacheDirectory)).toEqual(["unpacked"]);
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true });
      rmSync(cliDirectory, { recursive: true, force: true });
    }
  });

  it("reports nothing when the executable cannot be run", async () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), "version-cache-"));
    try {
      await expect(readCopilotCliVersion(join(cacheDirectory, "absent"), createVersionRunner(cacheDirectory))).resolves.toBeUndefined();
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true });
    }
  });
});
