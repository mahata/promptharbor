import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { CredentialStore } from "./keychain.ts";
import { DELETE_SAVED_TOKEN_COMMAND } from "./keychain.ts";
import { companionConfigPath, writeCompanionConfig } from "./config.ts";
import { discoverCopilotCli } from "./locate.ts";
import { COMPANION_EXECUTABLE_NAME, copilotCliCacheDirectory } from "./layout.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../protocol/identity.ts";

const SUPPORTED_PLATFORM = "darwin";
export const UNINSTALL_OPTION = "--uninstall";
export const KEEP_SAVED_PAT_OPTION = "--keep-saved-pat";
export const DELETE_SAVED_PAT_OPTION = "--delete-saved-pat";
export const SAVED_PAT_QUESTION = "Your macOS login keychain holds the PAT you saved for Prompt Harbor. Delete it too? [y/N] ";
const HOST_MANIFEST_MODE = 0o644;
const HOST_MANIFEST_COPY_PREFIX = `.${HOST_NAME}.json.`;
const STAGING_PREFIX = ".staging-";
const PREVIOUS_PREFIX = ".previous-";
const LEFTOVER_PREFIXES: readonly string[] = [STAGING_PREFIX, PREVIOUS_PREFIX];
const SUCCESS = 0;
const FAILURE = 1;

export type SavedPatChoice = "ask" | "keep" | "delete";
export type Confirm = (question: string) => Promise<boolean>;
export type InstallerOutput = { log: (line: string) => void; error: (line: string) => void };
export type DiscoverCli = (home: string) => Promise<string | undefined>;

export type UninstallOptions = {
  store: Pick<CredentialStore, "hasSavedToken" | "forgetToken">;
  // Present only when someone can answer, as in a terminal.
  confirm?: Confirm;
  output: InstallerOutput;
};

export type InstallerOptions = UninstallOptions & {
  args: readonly string[];
  platform: NodeJS.Platform;
  home: string;
  buildDirectory: string;
  discoverCli?: DiscoverCli;
};

type SavedPatDecision = "delete" | "keep" | "none" | "unknown";

type CompanionInstallPaths = ReturnType<typeof companionInstallPaths>;

export function companionInstallPaths(home: string) {
  const applicationSupport = join(home, "Library", "Application Support");
  const applicationDirectory = join(applicationSupport, "prompt-harbor");
  const companionDirectory = join(applicationDirectory, "companion");
  return {
    applicationDirectory,
    companionDirectory,
    configPath: companionConfigPath(applicationDirectory),
    cacheDirectory: copilotCliCacheDirectory(home),
    executablePath: join(companionDirectory, COMPANION_EXECUTABLE_NAME),
    hostManifestPath: join(applicationSupport, "Google", "Chrome", "NativeMessagingHosts", `${HOST_NAME}.json`),
  };
}

export async function runInstaller({ args, platform, home, buildDirectory, discoverCli, ...uninstallOptions }: InstallerOptions) {
  const { output } = uninstallOptions;
  if (platform !== SUPPORTED_PLATFORM) {
    output.error("The companion installer supports macOS only.");
    return FAILURE;
  }
  if (args.length === 0) {
    if (!(await isFile(join(buildDirectory, COMPANION_EXECUTABLE_NAME)))) {
      output.error(`No built companion was found in ${buildDirectory}.`);
      output.error("Run pnpm companion:install, which builds it first.");
      return FAILURE;
    }
    reportInstallation(await installCompanion(home, buildDirectory, discoverCli), output);
    output.log("It runs without this checkout or Node.js. Run pnpm companion:install again to update it.");
    return SUCCESS;
  }
  const savedPat = parseUninstallArguments(args);
  if (savedPat !== undefined) return uninstallCompanion(home, savedPat, uninstallOptions);
  output.error(`Usage: pnpm companion:install | pnpm companion:uninstall [${KEEP_SAVED_PAT_OPTION} | ${DELETE_SAVED_PAT_OPTION}]`);
  return FAILURE;
}

export function parseUninstallArguments(args: readonly string[]): SavedPatChoice | undefined {
  const [command, option, ...extra] = args;
  if (command !== UNINSTALL_OPTION || extra.length > 0) return undefined;
  if (option === undefined) return "ask";
  if (option === KEEP_SAVED_PAT_OPTION) return "keep";
  if (option === DELETE_SAVED_PAT_OPTION) return "delete";
  return undefined;
}

export function reportInstallation({ executablePath, hostManifestPath }: CompanionInstallPaths, output: InstallerOutput) {
  output.log("Installed the Prompt Harbor companion.");
  output.log(`  Companion: ${executablePath}`);
  output.log(`  Chrome host manifest: ${hostManifestPath}`);
  output.log("Reopen the extension's side panel to use it.");
}

export async function installCompanion(home: string, buildDirectory: string, discoverCli: DiscoverCli = defaultDiscoverCli) {
  const paths = companionInstallPaths(home);
  const { applicationDirectory, companionDirectory, executablePath, hostManifestPath } = paths;
  const hostManifestDirectory = dirname(hostManifestPath);
  const hostManifest = {
    name: HOST_NAME,
    description: "Local GitHub Copilot SDK companion for Prompt Harbor",
    path: executablePath,
    type: "stdio",
    allowed_origins: [EXTENSION_ORIGIN],
  };
  await mkdir(applicationDirectory, { recursive: true });
  await recoverFromInterruptedInstall(applicationDirectory, companionDirectory);
  const staging = await mkdtemp(join(applicationDirectory, STAGING_PREFIX));
  // Chrome reads only the manifest named after the host, so it never reads this copy half-written.
  const hostManifestCopy = join(hostManifestDirectory, `${HOST_MANIFEST_COPY_PREFIX}${randomUUID()}`);
  let installed = false;
  try {
    await cp(buildDirectory, staging, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    await mkdir(hostManifestDirectory, { recursive: true });
    await removeLeftovers(hostManifestDirectory, [HOST_MANIFEST_COPY_PREFIX]);
    await writeFile(hostManifestCopy, `${JSON.stringify(hostManifest, null, 2)}\n`, { flag: "wx" });
    await chmod(hostManifestCopy, HOST_MANIFEST_MODE);
    await replaceWithRenames(companionDirectory, staging, join(applicationDirectory, `${PREVIOUS_PREFIX}${randomUUID()}`), () =>
      rename(hostManifestCopy, hostManifestPath),
    );
    installed = true;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(hostManifestCopy, { force: true });
    if (!installed) await rmdir(applicationDirectory).catch(() => undefined);
  }
  await removeLeftovers(applicationDirectory, LEFTOVER_PREFIXES);
  await recordCopilotCli(paths, home, discoverCli);
  return paths;
}

const defaultDiscoverCli: DiscoverCli = (home) => discoverCopilotCli({ home });

// Looking for the Copilot CLI now saves the companion a search on every start. Chrome starts it
// with a bare PATH, so a path found here from a full shell environment is worth keeping. Failing
// to find one is not an install failure: the companion looks again, and the panel explains it.
async function recordCopilotCli({ configPath }: CompanionInstallPaths, home: string, discoverCli: DiscoverCli) {
  const copilotCliPath = await discoverCli(home).catch(() => undefined);
  if (copilotCliPath !== undefined) await writeCompanionConfig(configPath, { copilotCliPath });
  return copilotCliPath;
}

// The PAT question comes before anything is removed, so interrupting it leaves the companion installed.
export async function uninstallCompanion(home: string, savedPat: SavedPatChoice, { store, confirm, output }: UninstallOptions) {
  const decision = await decideSavedPat(savedPat, store, confirm);
  await uninstall(companionInstallPaths(home));
  output.log("Removed the Prompt Harbor companion.");
  return settleSavedPat(decision, store, output);
}

export function createTerminalConfirm(input: Readable & { isTTY?: boolean }, output: Writable & { isTTY?: boolean }): Confirm | undefined {
  if (input.isTTY !== true || output.isTTY !== true) return undefined;
  return async (question) => {
    // Without terminal handling, Ctrl-C stops the process as usual instead of being swallowed by readline.
    const prompt = createInterface({ input, output, terminal: false });
    try {
      const inputClosed = new Promise<string>((resolve) => prompt.once("close", () => resolve("")));
      const answer = await Promise.race([prompt.question(question), inputClosed]);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  };
}

async function decideSavedPat(
  choice: SavedPatChoice,
  store: UninstallOptions["store"],
  confirm: Confirm | undefined,
): Promise<SavedPatDecision> {
  if (choice === "delete") return "delete";
  const tokenIsSaved = await store.hasSavedToken().catch(() => undefined);
  if (tokenIsSaved === undefined) return "unknown";
  if (!tokenIsSaved) return "none";
  if (choice === "keep" || confirm === undefined) return "keep";
  return (await confirm(SAVED_PAT_QUESTION)) ? "delete" : "keep";
}

async function settleSavedPat(decision: SavedPatDecision, store: UninstallOptions["store"], output: InstallerOutput) {
  switch (decision) {
    case "delete":
      return forgetSavedToken(store, output);
    case "keep":
      output.log("Kept the PAT saved in your macOS login keychain. To delete it, run:");
      output.log(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
      output.log(`or delete the ${HOST_NAME} item in Keychain Access.`);
      return SUCCESS;
    case "none":
      output.log("No saved PAT was found in your macOS login keychain.");
      return SUCCESS;
    case "unknown":
      output.error("Could not check your macOS login keychain for a saved PAT. If one is saved, delete it with:");
      output.error(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
      output.error(`or delete the ${HOST_NAME} item in Keychain Access.`);
      return SUCCESS;
  }
}

// Moving the earlier install aside, the new copy in and the host manifest into place are all
// renames, so a failed or interrupted install never leaves a half-written companion where Chrome
// starts it. If the manifest cannot be put in place, the earlier companion goes back.
async function replaceWithRenames(target: string, replacement: string, previous: string, commit: () => Promise<void>) {
  const movedAside = await rename(target, previous).then(
    () => true,
    (error: unknown) => {
      if (isMissingFileError(error)) return false;
      throw error;
    },
  );
  try {
    await rename(replacement, target);
  } catch (error) {
    if (movedAside) await rename(previous, target);
    throw error;
  }
  try {
    await commit();
  } catch (error) {
    await rename(target, replacement);
    if (movedAside) await rename(previous, target);
    throw error;
  }
}

// An install stopped between its two renames leaves the earlier companion moved aside and none in
// place. Put it back, and delete moved-aside copies only while a companion is in place, so a copy
// that fails afterwards still leaves the earlier companion.
async function recoverFromInterruptedInstall(applicationDirectory: string, companionDirectory: string) {
  const entries = await readdir(applicationDirectory);
  const [movedAside, ...otherMovedAside] = entries.filter((entry) => entry.startsWith(PREVIOUS_PREFIX));
  if (movedAside !== undefined && otherMovedAside.length === 0 && !(await pathExists(companionDirectory))) {
    await rename(join(applicationDirectory, movedAside), companionDirectory);
  }
  await removeLeftovers(applicationDirectory, (await pathExists(companionDirectory)) ? LEFTOVER_PREFIXES : [STAGING_PREFIX]);
}

async function uninstall({ applicationDirectory, cacheDirectory, companionDirectory, configPath, hostManifestPath }: CompanionInstallPaths) {
  await rm(hostManifestPath, { force: true });
  await removeLeftovers(dirname(hostManifestPath), [HOST_MANIFEST_COPY_PREFIX]);
  await rm(companionDirectory, { recursive: true, force: true });
  await rm(configPath, { force: true });
  // The Copilot CLI runtime the companion had it unpack here is worth about 138 MB.
  await rm(cacheDirectory, { recursive: true, force: true });
  await rmdir(dirname(cacheDirectory)).catch(() => undefined);
  await removeLeftovers(applicationDirectory, LEFTOVER_PREFIXES);
  await rmdir(applicationDirectory).catch(() => undefined);
}

async function removeLeftovers(directory: string, prefixes: readonly string[]) {
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    if (prefixes.some((prefix) => entry.startsWith(prefix))) {
      await rm(join(directory, entry), { recursive: true, force: true });
    }
  }
}

async function forgetSavedToken(store: UninstallOptions["store"], output: InstallerOutput) {
  let tokenWasSaved: boolean;
  try {
    tokenWasSaved = await store.forgetToken();
  } catch {
    output.error("Could not remove the saved PAT from your macOS login keychain.");
    output.error(`Delete the ${HOST_NAME} item in Keychain Access instead.`);
    return FAILURE;
  }
  output.log(
    tokenWasSaved
      ? "Removed the saved PAT from your macOS login keychain."
      : "No saved PAT was found in your macOS login keychain.",
  );
  return SUCCESS;
}

async function isFile(path: string) {
  const file = await stat(path).catch(() => undefined);
  return file?.isFile() === true;
}

async function pathExists(path: string) {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissingFileError(error)) return false;
      throw error;
    },
  );
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
