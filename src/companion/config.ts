import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverCopilotCli, isExecutableFile, COPILOT_CLI_PATH_VARIABLE } from "./locate.ts";
import type { ExecutableCheck } from "./locate.ts";

export const CONFIG_FILE_NAME = "config.json";

const MAX_CONFIG_BYTES = 64 * 1024;
const CONFIG_FILE_MODE = 0o600;

export type CompanionConfig = { copilotCliPath?: string };

export type ResolvedCopilotCli = { path?: string; recorded?: string };

export type ResolveOptions = {
  configPath: string;
  home?: string;
  pathVariable?: string;
  // Set when the user pinned a path, normally from COPILOT_CLI_PATH.
  override?: string;
  isExecutable?: ExecutableCheck;
};

export function companionConfigPath(applicationDirectory: string) {
  return join(applicationDirectory, CONFIG_FILE_NAME);
}

export async function readCompanionConfig(configPath: string): Promise<CompanionConfig> {
  try {
    const text = await readFile(configPath, { encoding: "utf8" });
    if (text.length > MAX_CONFIG_BYTES) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const { copilotCliPath } = parsed as { copilotCliPath?: unknown };
    return typeof copilotCliPath === "string" && isAbsolute(copilotCliPath) ? { copilotCliPath } : {};
  } catch {
    return {};
  }
}

// Replaces the file with a rename so a reader never sees it half-written, and stays quiet on
// failure: an unwritable config only costs a rediscovery next time.
export async function writeCompanionConfig(configPath: string, config: CompanionConfig) {
  const staging = join(dirname(configPath), `.${CONFIG_FILE_NAME}.${randomUUID()}`);
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(staging, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: CONFIG_FILE_MODE });
    await rename(staging, configPath);
    return true;
  } catch {
    await rm(staging, { force: true }).catch(() => undefined);
    return false;
  }
}

// Prefers the recorded path so startup costs no directory scanning, but falls back to searching
// again when it has gone, which is what happens when the CLI is installed, moved or removed after
// the companion was. Deliberately does not record what it finds: the installer owns config.json,
// so a lookup never rewrites it. (The companion does write elsewhere in the home folder: reading
// the CLI's version has it unpack its runtime into the cache directory.)
export async function resolveCopilotCli({
  configPath,
  home,
  pathVariable,
  override = process.env[COPILOT_CLI_PATH_VARIABLE],
  isExecutable = isExecutableFile,
}: ResolveOptions): Promise<ResolvedCopilotCli> {
  const { copilotCliPath: recorded } = await readCompanionConfig(configPath);
  if (override === undefined && recorded !== undefined && (await isExecutable(recorded))) {
    return { path: recorded, recorded };
  }
  return { path: await discoverCopilotCli({ override, home, pathVariable, isExecutable }), recorded };
}
