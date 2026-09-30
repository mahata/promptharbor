import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companionBuildDirectory } from "../../src/companion/build.ts";
import { createFrameDecoder } from "../../src/companion/framing.ts";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { COMPANION_EXECUTABLE_NAME, UNINSTALL_SCRIPT_NAME } from "../../src/companion/layout.ts";
import { CONFIG_FILE_NAME } from "../../src/companion/config.ts";
import { buildCompanionPackage, POSTINSTALL_SCRIPT, runPackager } from "../../src/companion/package.ts";
import { EXTENSION_ORIGIN } from "../../src/protocol/identity.ts";

const INSTALLER_PATH = "/usr/sbin/installer";
const PKGUTIL_PATH = "/usr/sbin/pkgutil";
const OTHER_ARCHITECTURE = process.arch === "arm64" ? "x64" : "arm64";
const MACS: Record<string, string> = { arm64: "Macs with Apple silicon", x64: "Intel-based Macs" };
// Installing a package starts a companion in a home folder it has not used, so the Copilot CLI
// unpacks its runtime there first. See the note on startupTimeout in companion.test.ts.
const startupTimeout = { timeout: 45_000 };
const buildDirectory = companionBuildDirectory(process.arch);
const installedSdkVersion: unknown = JSON.parse(
  readFileSync(new URL("../../node_modules/@github/copilot-sdk/package.json", import.meta.url), "utf8"),
).version;
const temporaryDirectories: string[] = [];
const launchedCompanions: ChildProcess[] = [];
let packageDirectory: string;
let packagePath: string;
let realInstallBefore: ReturnType<typeof realInstallState>;

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// Installer puts a package for the current user into the folder that CFFIXED_USER_HOME names, so
// these tests never install into the home folder of the user running them.
function installPackage(path: string, home: string) {
  const { status, stdout, stderr } = spawnSync(INSTALLER_PATH, ["-pkg", path, "-target", "CurrentUserHomeDirectory"], {
    encoding: "utf8",
    env: { ...process.env, CFFIXED_USER_HOME: home },
  });
  return { status, output: `${stdout}${stderr}` };
}

// A stand-in for the companion that only records the arguments the postinstall script gives it.
function recordingBuild(recordPath: string) {
  const build = temporaryDirectory("package-recording-build-");
  writeFileSync(join(build, COMPANION_EXECUTABLE_NAME), `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\n`);
  chmodSync(join(build, COMPANION_EXECUTABLE_NAME), 0o755);
  return build;
}

function realInstallState() {
  const { companionDirectory, hostManifestPath } = companionInstallPaths(userInfo().homedir);
  return {
    hostManifest: existsSync(hostManifestPath) ? readFileSync(hostManifestPath, "utf8") : undefined,
    companion: existsSync(companionDirectory) ? statSync(companionDirectory).ino : undefined,
  };
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => !path.split("/").some((name) => name.startsWith("._")))
    .map((path) => {
      const entry = statSync(join(directory, path));
      return `${path} ${(entry.mode & 0o777).toString(8)} ${entry.isFile() ? entry.size : "dir"}`;
    })
    .sort();
}

function codesignVerifies(path: string) {
  return spawnSync("/usr/bin/codesign", ["--verify", "--strict", path]).status === 0;
}

async function expectGreeting(executablePath: string, home: string) {
  const child = spawn(executablePath, [EXTENSION_ORIGIN], { stdio: ["pipe", "pipe", "inherit"], env: { HOME: home } });
  launchedCompanions.push(child);
  const frames: unknown[] = [];
  const decoder = createFrameDecoder((frame) => frames.push(frame));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  await vi.waitFor(() => expect(frames).toEqual([expect.objectContaining({ type: "hello", sdkVersion: installedSdkVersion })]), startupTimeout);
  child.stdin.end();
  await expect(exitCode).resolves.toBe(0);
}

beforeAll(async () => {
  if (!existsSync(join(buildDirectory, COMPANION_EXECUTABLE_NAME))) {
    throw new Error(`There is no companion build in ${buildDirectory}. Run pnpm test:companion, which builds one first.`);
  }
  realInstallBefore = realInstallState();
  packageDirectory = temporaryDirectory("companion-packages-");

  const recordPath = join(temporaryDirectory("package-probe-"), "arguments");
  const probePackage = await buildCompanionPackage({
    buildDirectory: recordingBuild(recordPath),
    outputDirectory: packageDirectory,
    arch: process.arch,
    minimumMacOSVersion: "11.0",
    version: "0.0.1",
  });
  const probeHome = temporaryDirectory("package-probe-home-");
  expect(installPackage(probePackage, probeHome).status).toBe(0);
  const installedInto = readFileSync(recordPath, "utf8");
  if (installedInto !== `--install\n${realpathSync(probeHome)}\n`) {
    throw new Error(`Installer ignored CFFIXED_USER_HOME and would install into ${installedInto}, so no real package was installed.`);
  }

  const messages: string[] = [];
  const exitCode = await runPackager({
    platform: process.platform,
    buildDirectory,
    outputDirectory: packageDirectory,
    version: "0.1.0",
    output: { log: (line) => messages.push(line), error: (line) => messages.push(line) },
  });
  expect(exitCode, messages.join("\n")).toBe(0);
  packagePath = join(packageDirectory, `prompt-harbor-companion-0.1.0-macos-${process.arch}.pkg`);
  expect(messages).toContain(`  ${packagePath}`);
}, 120_000);

afterEach(() => {
  for (const child of launchedCompanions.splice(0)) child.kill("SIGKILL");
});

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    spawnSync("/bin/chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
  expect(realInstallState()).toEqual(realInstallBefore);
});

describe("companion package", { timeout: 120_000 }, () => {
  it("installs only for the current user, from scripts that carry the build unchanged", () => {
    expect(spawnSync(INSTALLER_PATH, ["-pkg", packagePath, "-dominfo"], { encoding: "utf8" }).stdout).toBe("CurrentUserHomeDirectory\n");

    const expanded = join(temporaryDirectory("package-expanded-"), "package");
    expect(spawnSync(PKGUTIL_PATH, ["--expand", packagePath, expanded]).status).toBe(0);
    const component = join(expanded, "companion.pkg");
    expect(readFileSync(join(component, "PackageInfo"), "utf8")).not.toContain("<payload");
    expect(readFileSync(join(component, "Scripts", "postinstall"), "utf8")).toBe(POSTINSTALL_SCRIPT);
    expect(listFiles(join(component, "Scripts", "companion"))).toEqual(listFiles(buildDirectory));
    expect(codesignVerifies(join(component, "Scripts", "companion", COMPANION_EXECUTABLE_NAME))).toBe(true);
    expect(readdirSync(join(expanded, "Resources")).filter((name) => !name.startsWith("._")).sort()).toEqual(["conclusion.txt", "welcome.txt"]);
  });

  it("installs a companion that Chrome can start into the home folder of the user who installs it, leaving no receipt", async () => {
    const home = temporaryDirectory("package-home-");
    const installed = installPackage(packagePath, home);
    expect(installed.status, installed.output).toBe(0);
    expect(installed.output).toContain("The install was successful.");

    const { companionDirectory, executablePath, hostManifestPath } = companionInstallPaths(realpathSync(home));
    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ path: executablePath, allowed_origins: [EXTENSION_ORIGIN] });
    expect(listFiles(companionDirectory)).toEqual(listFiles(buildDirectory));
    expect(codesignVerifies(executablePath)).toBe(true);
    await expectGreeting(executablePath, home);
    // Caches holds the Copilot CLI runtime the greeting had it unpack; nothing else is added.
    expect(readdirSync(join(home, "Library")).sort()).toEqual(["Application Support", "Caches"]);
  });

  it("replaces an earlier install completely", async () => {
    const home = temporaryDirectory("package-update-home-");
    expect(installPackage(packagePath, home).status).toBe(0);
    const { companionDirectory, executablePath } = companionInstallPaths(realpathSync(home));
    writeFileSync(join(companionDirectory, "left-by-earlier-install"), "");

    const updated = installPackage(packagePath, home);
    expect(updated.status, updated.output).toBe(0);
    expect(existsSync(join(companionDirectory, "left-by-earlier-install"))).toBe(false);
    await expectGreeting(executablePath, home);
  });

  it("fails without touching the earlier install when an update cannot be put in place", async () => {
    const home = temporaryDirectory("package-failed-update-home-");
    expect(installPackage(packagePath, home).status).toBe(0);
    const { applicationDirectory, companionDirectory, executablePath } = companionInstallPaths(realpathSync(home));
    writeFileSync(join(companionDirectory, "left-by-earlier-install"), "");
    chmodSync(applicationDirectory, 0o555);
    try {
      const failed = installPackage(packagePath, home);
      expect(failed.status).not.toBe(0);
      expect(failed.output).toContain("The install failed.");
    } finally {
      chmodSync(applicationDirectory, 0o755);
    }
    // config.json is there only when this Mac has a Copilot CLI to record, so what matters is
    // that no staging or moved-aside copy was left behind.
    expect(readdirSync(applicationDirectory).sort()).toEqual(
      ["companion", CONFIG_FILE_NAME].filter((entry) => existsSync(join(applicationDirectory, entry))).sort(),
    );
    expect(existsSync(join(companionDirectory, "left-by-earlier-install"))).toBe(true);
    await expectGreeting(executablePath, home);
  });

  it("refuses a Mac of the other architecture before running anything", async () => {
    const recordPath = join(temporaryDirectory("package-other-mac-"), "arguments");
    const otherPackage = await buildCompanionPackage({
      buildDirectory: recordingBuild(recordPath),
      outputDirectory: temporaryDirectory("package-other-mac-output-"),
      arch: OTHER_ARCHITECTURE,
      minimumMacOSVersion: "11.0",
      version: "0.1.0",
    });
    const home = temporaryDirectory("package-other-mac-home-");

    const refused = installPackage(otherPackage, home);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain(`This package is for ${MACS[OTHER_ARCHITECTURE]}`);
    expect(refused.output).toContain(`Use the Prompt Harbor companion package for ${MACS[process.arch]} instead.`);
    expect(existsSync(recordPath)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a macOS version older than the companion needs before running anything", async () => {
    const recordPath = join(temporaryDirectory("package-old-macos-"), "arguments");
    const futurePackage = await buildCompanionPackage({
      buildDirectory: recordingBuild(recordPath),
      outputDirectory: temporaryDirectory("package-old-macos-output-"),
      arch: process.arch,
      minimumMacOSVersion: "99.0",
      version: "0.1.0",
    });
    const home = temporaryDirectory("package-old-macos-home-");

    const refused = installPackage(futurePackage, home);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toMatch(/needs macOS 99\.0 or later\. This Mac has macOS \d+(\.\d+)*\./);
    expect(existsSync(recordPath)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it("installs an uninstall script that removes everything it installed", () => {
    const home = temporaryDirectory("package-uninstall-home-");
    expect(installPackage(packagePath, home).status).toBe(0);
    const { applicationDirectory, companionDirectory, hostManifestPath } = companionInstallPaths(realpathSync(home));

    const uninstalled = spawnSync(join(companionDirectory, UNINSTALL_SCRIPT_NAME), [], { encoding: "utf8", env: { HOME: home } });
    expect(uninstalled.status, uninstalled.stderr).toBe(0);
    expect(uninstalled.stdout).toContain("Removed the Prompt Harbor companion.");
    expect(uninstalled.stdout).toContain("No saved PAT was found in your macOS login keychain.");
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
  });
});
