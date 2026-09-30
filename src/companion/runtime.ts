import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveCopilotCli } from "./config.ts";
import type { ResolveOptions } from "./config.ts";
import { copilotCliCacheDirectory } from "./layout.ts";
import { createVersionRunner, readCopilotCliVersion } from "./version.ts";
import type { VersionRunner } from "./version.ts";

export type RuntimeStatus =
  | { state: "ready"; path: string; version: string }
  // Something is at `path`, but it does not answer `--version` like the Copilot CLI, so there is
  // no point handing it to the SDK. Whether a real Copilot CLI is too old or too new for the SDK
  // is not decided here: the SDK settles that with a protocol handshake when it starts one.
  | { state: "unsupported"; path: string }
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
  return version === undefined ? { state: "unsupported", path } : { state: "ready", path, version };
}

async function cachedVersionRunner(cacheDirectory: string) {
  await mkdir(cacheDirectory, { recursive: true }).catch(() => undefined);
  return createVersionRunner(cacheDirectory);
}
