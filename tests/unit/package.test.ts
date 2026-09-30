import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companionInstallPaths } from "../../src/companion/install.ts";
import { COMPANION_EXECUTABLE_NAME, LICENSE_FILE_NAME, NOTICES_FILE_NAME, UNINSTALL_SCRIPT_NAME } from "../../src/companion/layout.ts";
import { compareVersions } from "../../src/companion/version.ts";
import {
  companionPackageFileName,
  CONCLUSION_TEXT,
  distributionXml,
  INSTALLED_UNINSTALL_COMMAND,
  PACKAGE_IDENTIFIER,
  POSTINSTALL_SCRIPT,
  runPackager,
  welcomeText,
} from "../../src/companion/package.ts";
import type { PackagerOptions, PackageTarget } from "../../src/companion/package.ts";

const packageCliPath = fileURLToPath(new URL("../../src/companion/package-cli.ts", import.meta.url));
const appleSiliconPackage: PackageTarget = { arch: "arm64", minimumMacOSVersion: "13.5", version: "0.1.0" };
const intelPackage: PackageTarget = { arch: "x64", minimumMacOSVersion: "13.5", version: "0.1.0" };
let root: string;
let messages: { log: string[]; error: string[] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "companion-package-"));
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

// Runs the distribution's installation check the way Installer does, with its `system` and `my` objects.
function checkInstallation(xml: string, mac: { arm64Sysctl: number | undefined; macOSVersion: string }) {
  const script = /<script><!\[CDATA\[([\s\S]*?)\]\]><\/script>/.exec(xml)?.[1];
  if (script === undefined) throw new Error("The distribution has no script.");
  const context: { system: unknown; my: { result: Record<string, unknown> }; passed?: unknown } = {
    system: {
      version: { ProductVersion: mac.macOSVersion },
      compareVersions,
      sysctl: (name: string) => (name === "hw.optional.arm64" ? mac.arm64Sysctl : undefined),
    },
    my: { result: {} },
  };
  runInNewContext(`${script}\npassed = installationCheck();`, context);
  return { passed: context.passed, result: context.my.result };
}

function packager(overrides: Partial<PackagerOptions> = {}) {
  return runPackager({
    platform: "darwin",
    buildDirectory: join(root, "build"),
    outputDirectory: join(root, "dist-companion"),
    version: "0.1.0",
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
    ...overrides,
  });
}

describe("distributionXml", () => {
  it("installs only into the current user's home folder, with no choices to make", () => {
    const xml = distributionXml(appleSiliconPackage);
    expect(xml).toContain('<domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>');
    expect(xml).toContain('<options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>');
    expect(xml).toContain(`<pkg-ref id="${PACKAGE_IDENTIFIER}" version="0.1.0" onConclusion="none">companion.pkg</pkg-ref>`);
  });

  it("names the Macs each package is for", () => {
    expect(distributionXml(appleSiliconPackage)).toContain("<title>Prompt Harbor Companion (Apple silicon)</title>");
    expect(distributionXml(intelPackage)).toContain("<title>Prompt Harbor Companion (Intel)</title>");
  });

  it.each([
    ["the Apple silicon package on Apple silicon", appleSiliconPackage, 1],
    ["the Intel package on an Intel Mac without the sysctl", intelPackage, undefined],
    ["the Intel package on an Intel Mac with the sysctl at 0", intelPackage, 0],
  ])("lets Installer continue with %s", (_description, target, arm64Sysctl) => {
    expect(checkInstallation(distributionXml(target), { arm64Sysctl, macOSVersion: "14.6.1" })).toEqual({ passed: true, result: {} });
  });

  it.each([
    ["the Apple silicon package on an Intel Mac", appleSiliconPackage, undefined, "This package is for Macs with Apple silicon", "has an Intel processor. Use the Prompt Harbor companion package for Intel-based Macs instead."],
    ["the Intel package on Apple silicon", intelPackage, 1, "This package is for Intel-based Macs", "has Apple silicon. Use the Prompt Harbor companion package for Macs with Apple silicon instead."],
  ])("stops %s, saying which package to use", (_description, target, arm64Sysctl, title, message) => {
    const { passed, result } = checkInstallation(distributionXml(target), { arm64Sysctl, macOSVersion: "14.6.1" });
    expect(passed).toBe(false);
    expect(result).toEqual({ type: "Fatal", title, message: expect.stringContaining(message) });
  });

  it("stops on a macOS version older than the companion needs, comparing versions numerically", () => {
    const xml = distributionXml({ ...appleSiliconPackage, minimumMacOSVersion: "13.10" });
    expect(checkInstallation(xml, { arm64Sysctl: 1, macOSVersion: "13.10" }).passed).toBe(true);
    expect(checkInstallation(xml, { arm64Sysctl: 1, macOSVersion: "13.9.2" })).toEqual({
      passed: false,
      result: {
        type: "Fatal",
        title: "macOS 13.10 or later is required",
        message: "The Prompt Harbor companion needs macOS 13.10 or later. This Mac has macOS 13.9.2.",
      },
    });
  });

  it.each([
    ["an unknown architecture", { arch: "ia32" }, /arm64 and x64/],
    ["a version Installer cannot compare", { version: "0.1.0-beta" }, /not a version Installer accepts/],
    ["a macOS version that is not one", { minimumMacOSVersion: '13.5"/>' }, /not a macOS version/],
  ])("refuses %s", (_description, overrides, message) => {
    expect(() => distributionXml({ ...appleSiliconPackage, ...overrides })).toThrow(message);
  });
});

describe("Installer pages", () => {
  it("say what the package installs, where, for which Macs, under which terms, and who does not endorse it", () => {
    const welcome = welcomeText(appleSiliconPackage);
    expect(welcome).toContain(companionInstallPaths("~").companionDirectory);
    expect(welcome).toContain("needs no administrator password");
    expect(welcome).toContain("Macs with Apple silicon with macOS 13.5 or later");
    expect(welcome).toContain(`${LICENSE_FILE_NAME} and ${NOTICES_FILE_NAME}`);
    expect(welcome).toContain("not affiliated with, sponsored by or endorsed by GitHub");
  });

  it("end with how to uninstall, which leaves the saved PAT to the user", () => {
    expect(CONCLUSION_TEXT).toContain(`\n${INSTALLED_UNINSTALL_COMMAND}\n`);
    expect(CONCLUSION_TEXT).toContain("asks before deleting a PAT");
  });

  it("give an uninstall command that Terminal runs from the user's install", () => {
    const home = join(root, "home");
    writeExecutable(join(companionInstallPaths(home).companionDirectory, UNINSTALL_SCRIPT_NAME), "#!/bin/sh\necho uninstalled\n");

    const { status, stdout } = spawnSync("/bin/sh", ["-c", INSTALLED_UNINSTALL_COMMAND], { encoding: "utf8", env: { HOME: home } });
    expect(status).toBe(0);
    expect(stdout).toBe("uninstalled\n");
  });
});

describe("postinstall script", () => {
  it("has the packaged companion install itself into the home folder Installer passes", () => {
    const scripts = join(root, "Scripts");
    const argumentsPath = join(root, "arguments");
    writeExecutable(join(scripts, "postinstall"), POSTINSTALL_SCRIPT);
    writeExecutable(join(scripts, "companion", COMPANION_EXECUTABLE_NAME), `#!/bin/sh\necho "$@" > '${argumentsPath}'\n`);

    const { status } = spawnSync(join(scripts, "postinstall"), ["/tmp/package.pkg", "/Users/octo cat", "/", "/"], { cwd: root });
    expect(status).toBe(0);
    expect(readFileSync(argumentsPath, "utf8")).toBe("--install /Users/octo cat\n");
  });

  it("fails without starting the companion when Installer passes no home folder", () => {
    const scripts = join(root, "Scripts");
    const argumentsPath = join(root, "arguments");
    writeExecutable(join(scripts, "postinstall"), POSTINSTALL_SCRIPT);
    writeExecutable(join(scripts, "companion", COMPANION_EXECUTABLE_NAME), `#!/bin/sh\necho "$@" > '${argumentsPath}'\n`);

    expect(spawnSync(join(scripts, "postinstall"), ["/tmp/package.pkg"]).status).not.toBe(0);
    expect(existsSync(argumentsPath)).toBe(false);
  });
});

describe("runPackager", () => {
  it("names each package after its version and architecture", () => {
    expect(companionPackageFileName(appleSiliconPackage)).toBe("prompt-harbor-companion-0.1.0-macos-arm64.pkg");
    expect(companionPackageFileName(intelPackage)).toBe("prompt-harbor-companion-0.1.0-macos-x64.pkg");
  });

  it("refuses to package outside macOS without creating anything", async () => {
    await expect(packager({ platform: "linux" })).resolves.toBe(1);
    expect(messages.error.join("\n")).toMatch(/macOS only/);
    expect(existsSync(join(root, "dist-companion"))).toBe(false);
  });

  it("refuses an incomplete build without creating anything", async () => {
    writeExecutable(join(root, "build", COMPANION_EXECUTABLE_NAME), "#!/bin/sh\n");

    await expect(packager()).resolves.toBe(1);
    expect(messages.error.join("\n")).toContain("pnpm companion:package");
    expect(existsSync(join(root, "dist-companion"))).toBe(false);
  });

  it("refuses a build whose companion is not a Mac executable", async () => {
    const build = join(root, "build");
    writeExecutable(join(build, COMPANION_EXECUTABLE_NAME), "#!/bin/sh\n");
    for (const name of [UNINSTALL_SCRIPT_NAME, LICENSE_FILE_NAME, NOTICES_FILE_NAME]) writeFileSync(join(build, name), "");

    await expect(packager()).resolves.toBe(1);
    expect(messages.error.join("\n")).toContain("is not a 64-bit Mach-O file");
    expect(existsSync(join(root, "dist-companion"))).toBe(false);
  });

  it.skipIf(process.platform === "darwin")("refuses to package from the command line outside macOS", () => {
    const refused = spawnSync(process.execPath, [packageCliPath], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/macOS only/);
  });
});
