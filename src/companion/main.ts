import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getAsset, isSea } from "node:sea";
import { companionInstallPaths, createTerminalConfirm } from "./install.ts";
import { createKeychainStore } from "./keychain.ts";
import { BUILD_INFO_ASSET, copilotCliCacheDirectory } from "./layout.ts";
import { describeCopilotRuntime } from "./runtime.ts";
import { runCompanion } from "./run.ts";
import { createSdkGateway } from "./sdk-gateway.ts";
import { isSelfInstallerCommand, runSelfInstaller } from "./self-install.ts";
import { isBoundedField } from "../protocol/messages.ts";

const UNKNOWN_SDK_VERSION = "unknown";

// A built companion is a single executable application holding Node.js and the companion's code.
// Either way it drives the Copilot CLI the user installed, never a bundled runtime. Installing is
// left to pnpm companion:install when run from a checkout, because only a built companion can copy
// itself.
const isBuiltCompanion = isSea();
const args = process.argv.slice(2);

process.exitCode = isBuiltCompanion && isSelfInstallerCommand(args) ? await installOrUninstall() : await serveChrome();

function installOrUninstall() {
  return runSelfInstaller({
    args,
    executablePath: process.execPath,
    home: homedir(),
    store: createKeychainStore(),
    confirm: createTerminalConfirm(process.stdin, process.stdout),
    output: console,
  });
}

async function serveChrome() {
  const home = homedir();
  const { configPath } = companionInstallPaths(home);
  const cacheDirectory = copilotCliCacheDirectory(home);
  const companion = runCompanion({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    args,
    createGateway: (runtimePath) => createSdkGateway({ runtimePath, cacheDirectory }),
    resolveRuntime: () => describeCopilotRuntime({ configPath, home, cacheDirectory }),
    store: createKeychainStore(),
    sdkVersion: await readSdkVersion(isBuiltCompanion ? readBuiltSdkVersion : readCheckoutSdkVersion),
  });
  process.once("SIGTERM", () => void companion.shutdown());
  return companion.done;
}

async function readSdkVersion(read: () => Promise<unknown>) {
  try {
    const version = await read();
    return isBoundedField(version) ? version : UNKNOWN_SDK_VERSION;
  } catch {
    return UNKNOWN_SDK_VERSION;
  }
}

async function readBuiltSdkVersion() {
  const { sdkVersion }: { sdkVersion?: unknown } = JSON.parse(getAsset(BUILD_INFO_ASSET, "utf8"));
  return sdkVersion;
}

async function readCheckoutSdkVersion() {
  const sdkManifestUrl = new URL("../package.json", import.meta.resolve("@github/copilot-sdk"));
  const { version }: { version?: unknown } = JSON.parse(await readFile(sdkManifestUrl, "utf8"));
  return version;
}
