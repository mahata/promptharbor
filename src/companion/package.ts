import { constants } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CompanionBuildError, runTool } from "./build.ts";
import { companionInstallPaths } from "./install.ts";
import { COMPANION_EXECUTABLE_NAME, LICENSE_FILE_NAME, NOTICES_FILE_NAME, UNINSTALL_SCRIPT_NAME } from "./layout.ts";
import { readMachOSummary } from "./macho.ts";
import { INSTALL_OPTION } from "./self-install.ts";
import { HOST_NAME } from "../protocol/identity.ts";

const SUPPORTED_PLATFORM = "darwin";
const PKGBUILD_PATH = "/usr/bin/pkgbuild";
const PRODUCTBUILD_PATH = "/usr/bin/productbuild";
const STAGING_PREFIX = ".package-staging-";
const COMPONENT_PACKAGE_NAME = "companion.pkg";
const PACKAGED_COMPANION_DIRECTORY = "companion";
const WELCOME_FILE_NAME = "welcome.txt";
const CONCLUSION_FILE_NAME = "conclusion.txt";
const EXECUTABLE_MODE = 0o755;
const VERSION_PATTERN = /^\d+(\.\d+){0,2}$/;
const SUCCESS = 0;
const FAILURE = 1;

export const PACKAGE_IDENTIFIER = `${HOST_NAME}.companion`;
export const INSTALLED_UNINSTALL_COMMAND = `"${join(companionInstallPaths("$HOME").companionDirectory, UNINSTALL_SCRIPT_NAME)}"`;

// Installer runs this as the user who installs the package, because the package installs only
// into that user's home folder, which Installer passes as $2.
export const POSTINSTALL_SCRIPT = [
  "#!/bin/sh",
  "set -eu",
  `exec "$(dirname "$0")/${PACKAGED_COMPANION_DIRECTORY}/${COMPANION_EXECUTABLE_NAME}" ${INSTALL_OPTION} "$2"`,
  "",
].join("\n");

type MacKind = { label: string; macs: string; appleSilicon: boolean };

const MAC_KINDS: Readonly<Partial<Record<string, MacKind>>> = {
  arm64: { label: "Apple silicon", macs: "Macs with Apple silicon", appleSilicon: true },
  x64: { label: "Intel", macs: "Intel-based Macs", appleSilicon: false },
};

export type PackageTarget = { arch: string; minimumMacOSVersion: string; version: string };

export type PackagerOptions = {
  platform: NodeJS.Platform;
  buildDirectory: string;
  outputDirectory: string;
  version: string;
  output: { log: (line: string) => void; error: (line: string) => void };
};

export function companionPackageFileName({ arch, version }: Pick<PackageTarget, "arch" | "version">) {
  return `prompt-harbor-companion-${version}-macos-${arch}.pkg`;
}

export async function runPackager({ platform, buildDirectory, outputDirectory, version, output }: PackagerOptions) {
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion package builds on macOS only.");
    return FAILURE;
  }
  try {
    const target = { ...(await describeBuild(buildDirectory)), version };
    const packagePath = await buildCompanionPackage({ buildDirectory, outputDirectory, ...target });
    output.log(`Built the Prompt Harbor companion package for ${macKind(target.arch).macs} with macOS ${target.minimumMacOSVersion} or later:`);
    output.log(`  ${packagePath}`);
    output.log("It is not signed or notarized, so it is for testing only.");
    return SUCCESS;
  } catch (error) {
    if (!(error instanceof CompanionBuildError)) throw error;
    output.error(error.message);
    return FAILURE;
  }
}

// The package has no payload. Its scripts carry the companion build, and the postinstall script
// has the companion install itself, which replaces an earlier install only once the new one is
// complete and registers it with Chrome. That leaves no receipt behind for the uninstaller to miss.
export async function buildCompanionPackage({ buildDirectory, outputDirectory, ...target }: PackageTarget & { buildDirectory: string; outputDirectory: string }) {
  checkTarget(target);
  await mkdir(outputDirectory, { recursive: true });
  await removeStaleStagingDirectories(outputDirectory);
  const staging = await mkdtemp(join(outputDirectory, STAGING_PREFIX));
  try {
    const scriptsDirectory = join(staging, "scripts");
    const resourcesDirectory = join(staging, "resources");
    const distributionPath = join(staging, "Distribution.xml");
    const productPath = join(staging, "product.pkg");

    await mkdir(scriptsDirectory);
    await cp(buildDirectory, join(scriptsDirectory, PACKAGED_COMPANION_DIRECTORY), {
      recursive: true,
      errorOnExist: true,
      force: false,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
    await writeFile(join(scriptsDirectory, "postinstall"), POSTINSTALL_SCRIPT);
    await chmod(join(scriptsDirectory, "postinstall"), EXECUTABLE_MODE);
    runTool(PKGBUILD_PATH, [
      "--quiet",
      "--nopayload",
      "--scripts",
      scriptsDirectory,
      "--identifier",
      PACKAGE_IDENTIFIER,
      "--version",
      target.version,
      "--install-location",
      "/",
      join(staging, COMPONENT_PACKAGE_NAME),
    ]);

    await mkdir(resourcesDirectory);
    await writeFile(join(resourcesDirectory, WELCOME_FILE_NAME), welcomeText(target));
    await writeFile(join(resourcesDirectory, CONCLUSION_FILE_NAME), CONCLUSION_TEXT);
    await writeFile(distributionPath, distributionXml(target));
    runTool(PRODUCTBUILD_PATH, ["--quiet", "--distribution", distributionPath, "--resources", resourcesDirectory, "--package-path", staging, productPath]);

    const packagePath = join(outputDirectory, companionPackageFileName(target));
    await rename(productPath, packagePath);
    return packagePath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Installer offers only "Install for me only", so no administrator password is needed. It checks
// the architecture itself instead of relying on hostArchitectures, which would offer to install
// Rosetta and then install the Intel companion on Apple silicon.
export function distributionXml(target: PackageTarget) {
  checkTarget(target);
  const { arch, minimumMacOSVersion, version } = target;
  const mac = macKind(arch);
  const otherMac = macKind(mac.appleSilicon ? "x64" : "arm64");
  const requirements = {
    minimumMacOSVersion,
    appleSilicon: mac.appleSilicon,
    olderMacOS: {
      title: `macOS ${minimumMacOSVersion} or later is required`,
      message: `The Prompt Harbor companion needs macOS ${minimumMacOSVersion} or later.`,
    },
    otherMac: {
      title: `This package is for ${mac.macs}`,
      message:
        `This package is for ${mac.macs}, and this Mac ${mac.appleSilicon ? "has an Intel processor" : "has Apple silicon"}. ` +
        `Use the Prompt Harbor companion package for ${otherMac.macs} instead.`,
    },
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>${packageTitle(arch)}</title>
  <welcome file="${WELCOME_FILE_NAME}" mime-type="text/plain"/>
  <conclusion file="${CONCLUSION_FILE_NAME}" mime-type="text/plain"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <installation-check script="installationCheck()"/>
  <script><![CDATA[
var requirements = ${JSON.stringify(requirements)};

function installationCheck() {
  var macOSVersion = system.version.ProductVersion;
  if (system.compareVersions(macOSVersion, requirements.minimumMacOSVersion) < 0) {
    return refuse(requirements.olderMacOS.title, requirements.olderMacOS.message + " This Mac has macOS " + macOSVersion + ".");
  }
  if ((system.sysctl("hw.optional.arm64") == 1) !== requirements.appleSilicon) {
    return refuse(requirements.otherMac.title, requirements.otherMac.message);
  }
  return true;
}

function refuse(title, message) {
  my.result.type = "Fatal";
  my.result.title = title;
  my.result.message = message;
  return false;
}
]]></script>
  <choices-outline>
    <line choice="companion"/>
  </choices-outline>
  <choice id="companion" title="Prompt Harbor Companion">
    <pkg-ref id="${PACKAGE_IDENTIFIER}"/>
  </choice>
  <pkg-ref id="${PACKAGE_IDENTIFIER}" version="${version}" onConclusion="none">${COMPONENT_PACKAGE_NAME}</pkg-ref>
</installer-gui-script>
`;
}

export function welcomeText({ arch, minimumMacOSVersion }: Pick<PackageTarget, "arch" | "minimumMacOSVersion">) {
  return [
    "This installs the companion that the Prompt Harbor Chrome extension needs on this Mac. It runs the official GitHub Copilot SDK for the extension while the extension's side panel is open.",
    "",
    `It installs for your macOS user only, in ${companionInstallPaths("~").companionDirectory}, and registers itself with Google Chrome for the Prompt Harbor extension. It needs no administrator password. Installing this package again updates the companion and keeps any PAT you saved.`,
    "",
    `This package is for ${macKind(arch).macs} with macOS ${minimumMacOSVersion} or later.`,
    "",
    `The companion includes Node.js and the GitHub Copilot SDK, each under its own license. ${LICENSE_FILE_NAME} and ${NOTICES_FILE_NAME} in its folder give the terms. It drives the GitHub Copilot CLI you install yourself, which is not included.`,
    "",
    "Prompt Harbor is an independent, unofficial project. It is not affiliated with, sponsored by or endorsed by GitHub.",
    "",
  ].join("\n");
}

export const CONCLUSION_TEXT = [
  "The Prompt Harbor companion is installed. If a Prompt Harbor side panel is open in Google Chrome, close it and open it again.",
  "",
  "To uninstall the companion, run this command in Terminal:",
  "",
  INSTALLED_UNINSTALL_COMMAND,
  "",
  "It asks before deleting a PAT saved in your login keychain.",
  "",
].join("\n");

function packageTitle(arch: string) {
  return `Prompt Harbor Companion (${macKind(arch).label})`;
}

function macKind(arch: string) {
  const mac = MAC_KINDS[arch];
  if (mac === undefined) throw new CompanionBuildError(`The companion package supports arm64 and x64 Macs, not ${arch}.`);
  return mac;
}

function checkTarget({ arch, minimumMacOSVersion, version }: PackageTarget) {
  macKind(arch);
  if (!VERSION_PATTERN.test(minimumMacOSVersion)) throw new CompanionBuildError(`${minimumMacOSVersion} is not a macOS version.`);
  if (!VERSION_PATTERN.test(version)) throw new CompanionBuildError(`${version} is not a version Installer accepts, such as 1.2.3.`);
}

// Reads the architecture and minimum macOS version the companion was built for, so the package
// refuses Macs it cannot run on. The Copilot CLI it drives is the user's, with its own requirements.
async function describeBuild(buildDirectory: string) {
  for (const name of [COMPANION_EXECUTABLE_NAME, UNINSTALL_SCRIPT_NAME, LICENSE_FILE_NAME, NOTICES_FILE_NAME]) {
    if (!(await isFile(join(buildDirectory, name)))) {
      throw new CompanionBuildError(`No complete companion build was found in ${buildDirectory}. Run pnpm companion:package, which builds it first.`);
    }
  }
  const { arch, minimumMacOSVersion } = await readBinary(join(buildDirectory, COMPANION_EXECUTABLE_NAME));
  return { arch, minimumMacOSVersion };
}

async function readBinary(path: string) {
  try {
    return await readMachOSummary(path);
  } catch (error) {
    throw new CompanionBuildError(error instanceof Error ? error.message : `${path} could not be read.`);
  }
}

async function isFile(path: string) {
  const file = await stat(path).catch(() => undefined);
  return file?.isFile() === true;
}

async function removeStaleStagingDirectories(outputDirectory: string) {
  for (const entry of await readdir(outputDirectory)) {
    if (entry.startsWith(STAGING_PREFIX)) await rm(join(outputDirectory, entry), { recursive: true, force: true });
  }
}
