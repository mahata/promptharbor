import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameDecoder } from "../../src/companion/framing.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";

const mainPath = fileURLToPath(new URL("../../src/companion/main.ts", import.meta.url));
const installedSdkVersion: unknown = JSON.parse(
  readFileSync(new URL("../../node_modules/@github/copilot-sdk/package.json", import.meta.url), "utf8"),
).version;
const startupTimeout = { timeout: 10_000 };
const FAKE_CLI_VERSION = "1.0.99";
const launchedCompanions: ChildProcess[] = [];
let home: string;
let fakeCliDirectory: string;

// Chrome's PATH is searched before the usual install directories, so a fake Copilot CLI here makes
// the companion's lookup give the same answer on any machine, with or without a real one installed.
function writeFakeCopilotCli(directory: string) {
  const path = join(directory, "copilot");
  writeFileSync(path, `#!/bin/sh\necho 'GitHub Copilot CLI ${FAKE_CLI_VERSION}.'\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "companion-home-"));
  fakeCliDirectory = mkdtempSync(join(tmpdir(), "companion-cli-"));
  writeFakeCopilotCli(fakeCliDirectory);
});

afterEach(() => {
  for (const child of launchedCompanions.splice(0)) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
  rmSync(fakeCliDirectory, { recursive: true, force: true });
});

function launchCompanion(args: string[], { copilotCliPath }: { copilotCliPath?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: fakeCliDirectory };
  if (copilotCliPath !== undefined) env.COPILOT_CLI_PATH = copilotCliPath;
  const child = spawn(process.execPath, [mainPath, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
  launchedCompanions.push(child);
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  let outputByteCount = 0;
  let errorText = "";
  child.stdout.on("data", (chunk: Buffer) => {
    outputByteCount += chunk.length;
    decoder.push(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (errorText += chunk));
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, frames, exitCode, outputByteCount: () => outputByteCount, errorText: () => errorText };
}

describe("companion entry point", { timeout: 15_000 }, () => {
  it("refuses to start unless Chrome launches it for the extension", async () => {
    const { exitCode, outputByteCount, errorText } = launchCompanion([]);
    await expect(exitCode).resolves.toBe(1);
    expect(outputByteCount()).toBe(0);
    expect(errorText()).toMatch(/only runs when Chrome starts it/);
  });

  it("greets Chrome with the installed SDK version, the Copilot CLI it found and no saved PAT, then exits when its input ends", async () => {
    const { child, frames, exitCode } = launchCompanion([EXTENSION_ORIGIN]);
    await vi.waitFor(
      () =>
        expect(frames).toEqual([
          {
            type: "hello",
            protocolVersion: 4,
            sdkVersion: installedSdkVersion,
            savedToken: false,
            runtime: "ready",
            runtimeVersion: FAKE_CLI_VERSION,
          },
        ]),
      startupTimeout,
    );
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
    // The only thing it puts in the home folder is the cache it gives the Copilot CLI to unpack
    // into. It records nothing itself: that is the installer's job.
    expect(readdirSync(home)).toEqual(["Library"]);
    expect(existsSync(join(home, "Library", "Caches", "prompt-harbor", "copilot-cli"))).toBe(true);
    expect(existsSync(join(home, "Library", "Application Support"))).toBe(false);
  });

  it("tells Chrome the Copilot CLI is missing rather than refusing to start", async () => {
    const { child, frames, exitCode } = launchCompanion([EXTENSION_ORIGIN], { copilotCliPath: join(fakeCliDirectory, "gone") });
    await vi.waitFor(
      () =>
        expect(frames).toEqual([
          { type: "hello", protocolVersion: 4, sdkVersion: installedSdkVersion, savedToken: false, runtime: "missing" },
        ]),
      startupTimeout,
    );
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
  });

  it("exits cleanly when Chrome terminates it", async () => {
    const { child, frames, exitCode } = launchCompanion([EXTENSION_ORIGIN]);
    await vi.waitFor(() => expect(frames).toHaveLength(1), startupTimeout);
    child.kill("SIGTERM");
    await expect(exitCode).resolves.toBe(0);
  });
});
