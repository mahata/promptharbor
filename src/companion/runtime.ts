import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveCopilotCli } from "./config.ts";
import type { ResolveOptions } from "./config.ts";
import { copilotCliCacheDirectory } from "./layout.ts";
import { createVersionRunner, isSupportedCopilotCliVersion, readCopilotCliVersion } from "./version.ts";
import type { VersionRunner } from "./version.ts";

export type RuntimeStatus =
  | { state: "ready"; path: string; version: string }
  // Something is at `path`, but it is too old or does not answer `--version` like the Copilot CLI.
  | { state: "unsupported"; path: string; version?: string }
  | { state: "missing" };

export type DescribeRuntimeOptions = Partial<ResolveOptions> & {
  configPath: string;
  home?: string;
  cacheDirectory?: string;
  runVersion?: VersionRunner;
};

export async function describeCopilotRuntime({
  runVersion,
  home = homedir(),
  cacheDirectory = copilotCliCacheDirectory(home),
  ...options
}: DescribeRuntimeOptions): Promise<RuntimeStatus> {
  const { path } = await resolveCopilotCli({ home, ...options });
  if (path === undefined) return { state: "missing" };
  const version = await readCopilotCliVersion(path, runVersion ?? (await cachedVersionRunner(cacheDirectory)));
  if (version === undefined) return { state: "unsupported", path };
  return isSupportedCopilotCliVersion(version) ? { state: "ready", path, version } : { state: "unsupported", path, version };
}

async function cachedVersionRunner(cacheDirectory: string) {
  await mkdir(cacheDirectory, { recursive: true }).catch(() => undefined);
  return createVersionRunner(cacheDirectory);
}
