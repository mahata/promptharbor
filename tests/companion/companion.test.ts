import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companionBuildDirectory, UNINSTALL_SCRIPT } from "../../src/companion/build.ts";
import { createFrameDecoder, encodeFrame } from "../../src/companion/framing.ts";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { nodeLicenseUrl } from "../../src/companion/notices.ts";
import { COMPANION_EXECUTABLE_NAME, LICENSE_FILE_NAME, NOTICES_FILE_NAME, UNINSTALL_SCRIPT_NAME } from "../../src/companion/layout.ts";
import { discoverCopilotCli } from "../../src/companion/locate.ts";
import { REFUSAL_NOTICE } from "../../src/companion/run.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";
import { PROTOCOL_VERSION } from "../../src/protocol/messages.ts";

const MACH_O_ARCHITECTURES: Partial<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
// Denies every network connection except to Unix domain sockets, so a fake PAT never leaves this Mac.
const NO_NETWORK_PROFILE = "(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote unix-socket))";
const fakeToken = `github_pat_${"Z".repeat(82)}`;
const startupTimeout = { timeout: 10_000 };
const connectTimeout = { timeout: 20_000 };
const buildDirectory = companionBuildDirectory(process.arch);
const builtExecutablePath = join(buildDirectory, COMPANION_EXECUTABLE_NAME);
const installCliPath = fileURLToPath(new URL("../../src/companion/install-cli.ts", import.meta.url));
const installedSdkVersion: unknown = JSON.parse(
  readFileSync(new URL("../../node_modules/@github/copilot-sdk/package.json", import.meta.url), "utf8"),
).version;
const launchedCompanions: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  if (!existsSync(builtExecutablePath)) {
    throw new Error(`There is no companion build in ${buildDirectory}. Run pnpm test:companion, which builds one first.`);
  }
  // The companion no longer carries a Copilot runtime: it drives the Copilot CLI on this Mac, so
  // these tests need one installed, as a person using the companion would have.
  if ((await discoverCopilotCli()) === undefined) {
    throw new Error("These tests need the GitHub Copilot CLI on this Mac. Install it with: brew install --cask copilot-cli");
  }
});

afterEach(() => {
  for (const child of launchedCompanions.splice(0)) child.kill("SIGKILL");
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function launchCompanion(executablePath: string, env: NodeJS.ProcessEnv, { sandboxed = false } = {}) {
  const command = sandboxed ? SANDBOX_EXEC_PATH : executablePath;
  const args = sandboxed ? ["-p", NO_NETWORK_PROFILE, executablePath, EXTENSION_ORIGIN] : [EXTENSION_ORIGIN];
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env });
  launchedCompanions.push(child);
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, frames, exitCode };
}

function connectsTo(port: number, { sandboxed }: { sandboxed: boolean }) {
  const probe = [
    "--eval",
    `require("node:net").connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));`,
  ];
  const { status } = sandboxed
    ? spawnSync(SANDBOX_EXEC_PATH, ["-p", NO_NETWORK_PROFILE, process.execPath, ...probe], { timeout: startupTimeout.timeout })
    : spawnSync(process.execPath, probe, { timeout: startupTimeout.timeout });
  return status === 0;
}

function codesign(args: string[]) {
  return spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
}

describe("built companion", () => {
  it("is a signed executable for this Mac's architecture", () => {
    const fileType = spawnSync("/usr/bin/file", ["-b", builtExecutablePath], { encoding: "utf8" }).stdout;
    expect(fileType).toBe(`Mach-O 64-bit executable ${MACH_O_ARCHITECTURES[process.arch]}\n`);
    expect(codesign(["--verify", "--strict", builtExecutablePath]).status).toBe(0);
  });


  it("carries an uninstall script, this project's license and notices for the third-party software in it", () => {
    const uninstallScriptPath = join(buildDirectory, UNINSTALL_SCRIPT_NAME);
    expect(readFileSync(uninstallScriptPath, "utf8")).toBe(UNINSTALL_SCRIPT);
    expect(statSync(uninstallScriptPath).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(buildDirectory, LICENSE_FILE_NAME), "utf8")).toBe(readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"));

    const notices = readFileSync(join(buildDirectory, NOTICES_FILE_NAME), "utf8");
    expect(notices).toContain(`\nNode.js ${process.version}\n`);
    expect(notices).toContain(
      existsSync(join(dirname(dirname(process.execPath)), "LICENSE")) ? "Node.js is licensed for use as follows:" : nodeLicenseUrl(process.version),
    );
    expect(notices).toContain(`\n@github/copilot-sdk ${String(installedSdkVersion)}\n`);
    expect(notices).not.toContain("@github/copilot-sdk-darwin-");
    expect(notices).toContain("\nvscode-jsonrpc ");
  });

  it("refuses to start unless Chrome launches it for the extension", () => {
    const refused = spawnSync(builtExecutablePath, [], { encoding: "utf8", env: {} });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(REFUSAL_NOTICE);
  });

  it("greets Chrome with the SDK version it was built with and the Copilot CLI it found, without Node.js or even a PATH", async () => {
    const home = temporaryDirectory("companion-home-");
    const { child, frames, exitCode } = launchCompanion(builtExecutablePath, { HOME: home });
    await vi.waitFor(
      () =>
        expect(frames).toEqual([
          {
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            sdkVersion: installedSdkVersion,
            savedToken: false,
            runtime: "ready",
            runtimeVersion: expect.stringMatching(/^\d+(\.\d+)*(-\d+)?$/),
          },
        ]),
      startupTimeout,
    );
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
    // Reading the Copilot CLI's version has it unpack its runtime into the companion's cache, and
    // that is the only thing the companion puts in the home folder it was given.
    expect(readdirSync(home)).toEqual(["Library"]);
    expect(existsSync(companionInstallPaths(home).cacheDirectory)).toBe(true);
    expect(existsSync(companionInstallPaths(home).applicationDirectory)).toBe(false);
  });

  it("ignores NODE_OPTIONS, which would otherwise let another program load code into it", () => {
    const directory = temporaryDirectory("companion-node-options-");
    const markerPath = join(directory, "preloaded");
    const preloadPath = join(directory, "preload.cjs");
    writeFileSync(preloadPath, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "");\n`);
    const env = { NODE_OPTIONS: `--require=${preloadPath}` };

    spawnSync(process.execPath, ["--eval", ""], { env });
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);

    expect(spawnSync(builtExecutablePath, [], { env }).status).toBe(1);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("connects from a copy elsewhere through its own SDK and the installed Copilot CLI, which reject a fake PAT", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(connectsTo(port, { sandboxed: false })).toBe(true);
      expect(connectsTo(port, { sandboxed: true })).toBe(false);
    } finally {
      server.close();
    }

    const copy = join(temporaryDirectory("companion-copy-"), "companion");
    cpSync(buildDirectory, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
    const home = temporaryDirectory("companion-home-");
    const runtimeParentDirectory = temporaryDirectory("companion-tmpdir-");
    const { child, frames, exitCode } = launchCompanion(
      join(copy, COMPANION_EXECUTABLE_NAME),
      { HOME: home, TMPDIR: runtimeParentDirectory },
      { sandboxed: true },
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1), startupTimeout);

    child.stdin.write(encodeFrame({ type: "connect", token: fakeToken, remember: false }));
    await vi.waitFor(() => expect(frames).toHaveLength(2), connectTimeout);
    expect(frames[1]).toEqual({ type: "error", stage: "connect", code: "auth_failed" });
    expect(readdirSync(runtimeParentDirectory)).toEqual([]);

    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);
  });
});

describe("self-installing companion", () => {
  it("installs itself into a home folder and uninstalls through the script beside it", async () => {
    const home = temporaryDirectory("companion-self-install-home-");
    const installed = spawnSync(builtExecutablePath, ["--install", home], { encoding: "utf8", env: {} });
    expect(installed.status).toBe(0);
    const { applicationDirectory, companionDirectory, executablePath, hostManifestPath } = companionInstallPaths(home);
    expect(installed.stdout).toContain(executablePath);
    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ path: executablePath, allowed_origins: [EXTENSION_ORIGIN] });
    expect(readdirSync(companionDirectory).sort()).toEqual(readdirSync(buildDirectory).sort());

    const { child, frames, exitCode } = launchCompanion(executablePath, { HOME: home });
    await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ type: "hello", sdkVersion: installedSdkVersion })]), startupTimeout);
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);

    const uninstalled = spawnSync(join(companionDirectory, UNINSTALL_SCRIPT_NAME), [], { encoding: "utf8", env: { HOME: home } });
    expect(uninstalled.status).toBe(0);
    expect(uninstalled.stdout).toContain("Removed the Prompt Harbor companion.");
    expect(uninstalled.stdout).toContain("No saved PAT was found in your macOS login keychain.");
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
  });
});

describe("installed companion", () => {
  it("is a copy of the build that Chrome can start from its install location until it is uninstalled", async () => {
    const home = temporaryDirectory("companion-install-home-");
    const env = { ...process.env, HOME: home };
    expect(spawnSync(process.execPath, [installCliPath], { encoding: "utf8", env }).status).toBe(0);
    const { applicationDirectory, configPath, executablePath, hostManifestPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ path: executablePath, allowed_origins: [EXTENSION_ORIGIN] });
    expect(realpathSync(executablePath)).not.toBe(realpathSync(builtExecutablePath));
    expect(statSync(executablePath).size).toBe(statSync(builtExecutablePath).size);
    expect(codesign(["--verify", "--strict", executablePath]).status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ copilotCliPath: await discoverCopilotCli({ home }) });

    const { child, frames, exitCode } = launchCompanion(executablePath, { HOME: home });
    await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ type: "hello", sdkVersion: installedSdkVersion })]), startupTimeout);
    child.stdin.end();
    await expect(exitCode).resolves.toBe(0);

    const uninstalled = spawnSync(process.execPath, [installCliPath, "--uninstall"], { encoding: "utf8", env });
    expect(uninstalled.status).toBe(0);
    expect(uninstalled.stdout).toContain("No saved PAT was found in your macOS login keychain.");
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
  });
});
