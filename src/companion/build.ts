import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "rolldown";
import { DELETE_SAVED_PAT_OPTION, KEEP_SAVED_PAT_OPTION, UNINSTALL_OPTION } from "./install.ts";
import {
  BUILD_INFO_ASSET,
  COMPANION_EXECUTABLE_NAME,
  LICENSE_FILE_NAME,
  NOTICES_FILE_NAME,
  UNINSTALL_SCRIPT_NAME,
} from "./layout.ts";
import type { BuildInfo } from "./layout.ts";
import { describeNode, describePackage, findPackageDirectories, formatNotices } from "./notices.ts";
import type { NoticeComponent } from "./notices.ts";
import { REFUSAL_NOTICE } from "./run.ts";

const SUPPORTED_PLATFORM = "darwin";
const SUPPORTED_ARCHITECTURES: readonly string[] = ["arm64", "x64"];
const CODESIGN_PATH = "/usr/bin/codesign";
const STAGING_SUFFIX = ".staging-";
const KOFFI_STUB_ID = "\0prompt-harbor:koffi-stub";
const SMOKE_TEST_TIMEOUT_MS = 10_000;
const EXECUTABLE_MODE = 0o755;
const SUCCESS = 0;
const FAILURE = 1;

export const UNINSTALL_SCRIPT = [
  "#!/bin/sh",
  "# Removes the Prompt Harbor companion installed for this macOS user. It asks whether to delete the",
  `# saved PAT as well, unless ${KEEP_SAVED_PAT_OPTION} or ${DELETE_SAVED_PAT_OPTION} decides.`,
  `exec "$(dirname "$0")/${COMPANION_EXECUTABLE_NAME}" ${UNINSTALL_OPTION} "$@"`,
  "",
].join("\n");

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const companionEntryPath = fileURLToPath(new URL("./main.ts", import.meta.url));

export type BuilderOptions = {
  platform: NodeJS.Platform;
  arch: string;
  outputDirectory: string;
  output: { log: (line: string) => void; error: (line: string) => void };
};

export class CompanionBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionBuildError";
  }
}

export function companionBuildDirectory(arch: string) {
  return join(repositoryRoot, "dist-companion", `${SUPPORTED_PLATFORM}-${arch}`);
}

export async function runBuilder({ platform, arch, outputDirectory, output }: BuilderOptions) {
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion builds on macOS only, for the Mac that builds it.");
    return FAILURE;
  }
  if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
    output.error(`The companion builds for Apple silicon (arm64) and Intel (x64) Macs, not ${arch}.`);
    return FAILURE;
  }
  try {
    const { sdkVersion, missingNodeLicensePath } = await buildCompanion(outputDirectory);
    output.log(`Built the Prompt Harbor companion for ${SUPPORTED_PLATFORM}-${arch} with Copilot SDK ${sdkVersion}:`);
    output.log(`  ${outputDirectory}`);
    if (missingNodeLicensePath !== undefined) {
      output.error(`Node.js's LICENSE is not at ${missingNodeLicensePath}, so ${NOTICES_FILE_NAME} links to it instead of including it.`);
      output.error("Do not distribute this build. Build with a Node.js that keeps its LICENSE there, such as one from a nodejs.org tarball.");
    }
    return SUCCESS;
  } catch (error) {
    if (!(error instanceof CompanionBuildError)) throw error;
    output.error(error.message);
    return FAILURE;
  }
}

// The build runs this Node.js binary's single executable application support, so it produces a
// companion for this Node.js binary's architecture only.
async function buildCompanion(outputDirectory: string): Promise<BuildInfo & { missingNodeLicensePath?: string }> {
  const sdkVersion = await readSdkVersion();
  await mkdir(dirname(outputDirectory), { recursive: true });
  await removeStaleStagingDirectories(outputDirectory);
  const staging = await mkdtemp(`${outputDirectory}${STAGING_SUFFIX}`);
  try {
    const companionDirectory = join(staging, "companion");
    const intermediatesDirectory = join(staging, "intermediates");
    const executablePath = join(companionDirectory, COMPANION_EXECUTABLE_NAME);
    const bundlePath = join(intermediatesDirectory, "companion.mjs");
    const buildInfoPath = join(intermediatesDirectory, BUILD_INFO_ASSET);
    const seaConfigPath = join(intermediatesDirectory, "sea-config.json");
    const buildInfo: BuildInfo = { sdkVersion };

    await mkdir(companionDirectory);
    const bundledModuleIds = await bundleCompanion(bundlePath);
    await writeFile(buildInfoPath, JSON.stringify(buildInfo));
    await writeFile(
      seaConfigPath,
      JSON.stringify({
        main: bundlePath,
        mainFormat: "module",
        output: executablePath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: "none",
        assets: { [BUILD_INFO_ASSET]: buildInfoPath },
      }),
    );
    runTool(process.execPath, ["--build-sea", seaConfigPath]);
    runTool(CODESIGN_PATH, ["--sign", "-", "--force", executablePath]);

    await writeFile(join(companionDirectory, UNINSTALL_SCRIPT_NAME), UNINSTALL_SCRIPT);
    await chmod(join(companionDirectory, UNINSTALL_SCRIPT_NAME), EXECUTABLE_MODE);
    await copyFile(join(repositoryRoot, "LICENSE"), join(companionDirectory, LICENSE_FILE_NAME));
    const node = await describeNode(process.execPath, process.version);
    await writeFile(join(companionDirectory, NOTICES_FILE_NAME), await thirdPartyNotices(node, bundledModuleIds));
    checkCompanionRefusesToStartAlone(executablePath);

    await rm(outputDirectory, { recursive: true, force: true });
    await rename(companionDirectory, outputDirectory);
    return node.licenseText === undefined ? { ...buildInfo, missingNodeLicensePath: node.licensePath } : buildInfo;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// The companion drives the Copilot CLI the user installed, so only the SDK's own version is
// recorded here. Its platform runtime package is no longer copied into the build.
async function readSdkVersion() {
  const sdkManifestPath = fileURLToPath(new URL("../package.json", import.meta.resolve("@github/copilot-sdk")));
  return readPackageVersion(sdkManifestPath);
}

async function readPackageVersion(manifestPath: string) {
  const { version }: { version?: unknown } = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof version !== "string") throw new CompanionBuildError(`${manifestPath} has no version.`);
  return version;
}

async function bundleCompanion(bundlePath: string) {
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: companionEntryPath,
    cwd: repositoryRoot,
    platform: "node",
    plugins: [stubKoffi()],
    logLevel: "warn",
    onLog(level, log, handler) {
      handler(level === "warn" ? "error" : level, log);
    },
  });
  try {
    const { output } = await bundle.write({ file: bundlePath, format: "esm", codeSplitting: false });
    return output.flatMap((file) => (file.type === "chunk" ? file.moduleIds : []));
  } finally {
    await bundle.close();
  }
}

async function thirdPartyNotices(node: NoticeComponent, bundledModuleIds: readonly string[]) {
  const bundledPackages = await Promise.all(
    (await findPackageDirectories(bundledModuleIds)).map((directory) => describePackage(directory, "Bundled into the companion executable.")),
  );
  return formatNotices([node, ...bundledPackages.sort((first, second) => first.name.localeCompare(second.name))]);
}

// The SDK needs koffi only for its in-process runtime. The companion always starts the Copilot CLI
// as a child process, and a single executable application could not load koffi's native addon anyway.
function stubKoffi(): Plugin {
  return {
    name: "prompt-harbor:stub-koffi",
    resolveId(source) {
      return source === "koffi" ? KOFFI_STUB_ID : null;
    },
    load(id) {
      if (id !== KOFFI_STUB_ID) return null;
      return 'export default new Proxy({}, { get() { throw new Error("The companion does not include koffi."); } });';
    },
  };
}

function checkCompanionRefusesToStartAlone(executablePath: string) {
  const { status, stdout, stderr } = spawnSync(executablePath, [], { encoding: "utf8", env: {}, timeout: SMOKE_TEST_TIMEOUT_MS });
  if (status !== FAILURE || stdout !== "" || stderr !== REFUSAL_NOTICE) {
    throw new CompanionBuildError("The built companion did not start. Its single executable application may be damaged.");
  }
}

export function runTool(command: string, args: readonly string[]) {
  const { status, stderr, error } = spawnSync(command, args, { encoding: "utf8" });
  if (status === SUCCESS) return;
  const detail = error?.message ?? stderr.trim();
  throw new CompanionBuildError(`${basename(command)} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
}

async function removeStaleStagingDirectories(outputDirectory: string) {
  const prefix = `${basename(outputDirectory)}${STAGING_SUFFIX}`;
  for (const entry of await readdir(dirname(outputDirectory))) {
    if (entry.startsWith(prefix)) await rm(join(dirname(outputDirectory), entry), { recursive: true, force: true });
  }
}
