import { spawn } from "node:child_process";
import { SYSTEM_PATH } from "./system-path.ts";
import { MINIMUM_COPILOT_CLI_VERSION } from "../protocol/messages.ts";

export { MINIMUM_COPILOT_CLI_VERSION };

export const MAX_VERSION_OUTPUT_LENGTH = 4_096;

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_ARGUMENTS = ["--version"];
// `copilot --version` prints "GitHub Copilot CLI 1.0.89-3." and then a line about updates.
const VERSION_PATTERN = /GitHub Copilot CLI\s+(\d+(?:\.\d+)*(?:-\d+)?)/;

export type VersionRunner = (executablePath: string) => Promise<string>;
export function compareVersions(first: string, second: string) {
  const firstParts = splitVersion(first);
  const secondParts = splitVersion(second);
  for (let index = 0; index < Math.max(firstParts.length, secondParts.length); index += 1) {
    const difference = (firstParts[index] ?? 0) - (secondParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseCopilotCliVersion(output: string) {
  return VERSION_PATTERN.exec(output)?.[1];
}

export function isSupportedCopilotCliVersion(version: string) {
  return compareVersions(version, MINIMUM_COPILOT_CLI_VERSION) >= 0;
}

// Returns the version the Copilot CLI reports, or undefined when it cannot be run or says
// something this does not recognise. Telling those apart is left to the caller, which already
// knows whether the executable was there at all.
export async function readCopilotCliVersion(executablePath: string, run: VersionRunner) {
  try {
    return parseCopilotCliVersion(await run(executablePath));
  } catch {
    return undefined;
  }
}

// Runs the Copilot CLI with the companion's cache directory as HOME, so this first use unpacks its
// runtime where the connection that follows will find it again instead of doing the work twice.
export function createVersionRunner(cacheDirectory: string): VersionRunner {
  return (executablePath) =>
    new Promise<string>((resolve) => {
      let output = "";
      const child = spawn(executablePath, VERSION_ARGUMENTS, {
        env: { HOME: cacheDirectory, PATH: SYSTEM_PATH },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      child.once("error", () => resolve(""));
      child.once("close", () => resolve(output));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output = (output + chunk).slice(0, MAX_VERSION_OUTPUT_LENGTH);
      });
    });
}

// Splits on both separators so a prerelease such as 1.0.89-3 orders after 1.0.89, and a Mach-O
// version such as 13.5 keeps comparing as it always did.
function splitVersion(version: string) {
  return version.split(/[.-]/).map((part) => {
    const value = Number(part);
    return Number.isFinite(value) ? value : 0;
  });
}
