import { join } from "node:path";

export const COMPANION_EXECUTABLE_NAME = "prompt-harbor-companion";
export const UNINSTALL_SCRIPT_NAME = "uninstall";
export const LICENSE_FILE_NAME = "LICENSE.txt";
export const NOTICES_FILE_NAME = "THIRD-PARTY-NOTICES.txt";
export const BUILD_INFO_ASSET = "build-info.json";

export type BuildInfo = { sdkVersion: string };

// The Copilot CLI unpacks its runtime into $HOME/Library/Caches on first use, about 138 MB. The
// companion gives it this directory as HOME so that happens once instead of on every connection,
// while its Copilot home, temporary directory and working directory stay throwaway ones.
export function copilotCliCacheDirectory(home: string) {
  return join(home, "Library", "Caches", "prompt-harbor", "copilot-cli");
}
