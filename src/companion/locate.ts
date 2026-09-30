import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const COPILOT_CLI_EXECUTABLE_NAME = "copilot";
export const COPILOT_CLI_PATH_VARIABLE = "COPILOT_CLI_PATH";

// Chrome starts the companion with SYSTEM_PATH, which holds none of the places a Copilot CLI is
// normally installed, so these directories are searched directly. Relative order is install
// popularity: Homebrew first, then the usual npm and pipx style prefixes.
const CANDIDATE_DIRECTORIES: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];
const HOME_CANDIDATE_DIRECTORIES: readonly string[] = [
  join(".local", "bin"),
  join(".npm-global", "bin"),
  join("node_modules", ".bin"),
];

export type ExecutableCheck = (path: string) => Promise<boolean>;

export type DiscoveryOptions = {
  // A path the user pinned, from COPILOT_CLI_PATH or the companion's config file.
  override?: string;
  home?: string;
  pathVariable?: string;
  isExecutable?: ExecutableCheck;
};

// Deliberately does not resolve symlinks. Homebrew's /opt/homebrew/bin/copilot points into a
// versioned Caskroom directory, so recording the link target would break on the next upgrade,
// while the link itself stays put.
//
// An override is authoritative: someone who pins COPILOT_CLI_PATH means that Copilot CLI, so a
// pin that is not there reports nothing rather than quietly running a different one. The path the
// installer recorded is only a cache, and the caller falls back to searching when it goes stale.
export async function discoverCopilotCli({
  override,
  home = homedir(),
  pathVariable = process.env.PATH ?? "",
  isExecutable = isExecutableFile,
}: DiscoveryOptions = {}) {
  if (override !== undefined) return isAbsolute(override) && (await isExecutable(override)) ? override : undefined;
  for (const candidate of copilotCliCandidates({ home, pathVariable })) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function copilotCliCandidates({
  home = homedir(),
  pathVariable = process.env.PATH ?? "",
}: Omit<DiscoveryOptions, "isExecutable" | "override"> = {}) {
  const directories = [
    ...pathVariable.split(delimiter).filter((directory) => isAbsolute(directory)),
    ...CANDIDATE_DIRECTORIES,
    ...HOME_CANDIDATE_DIRECTORIES.map((directory) => join(home, directory)),
  ];
  return [...new Set(directories.map((directory) => join(directory, COPILOT_CLI_EXECUTABLE_NAME)))];
}

export async function isExecutableFile(path: string) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}
