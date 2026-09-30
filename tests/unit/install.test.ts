import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { PassThrough } from "node:stream";
import { companionInstallPaths, createTerminalConfirm, runInstaller, SAVED_PAT_QUESTION } from "../../src/companion/install.ts";
import type { Confirm } from "../../src/companion/install.ts";
import { createKeychainStore, DELETE_SAVED_TOKEN_COMMAND } from "../../src/companion/keychain.ts";
import type { SecurityRunner } from "../../src/companion/keychain.ts";
import { COMPANION_EXECUTABLE_NAME } from "../../src/companion/layout.ts";
import { CONFIG_FILE_NAME } from "../../src/companion/config.ts";
import { EXTENSION_ORIGIN, HOST_NAME } from "../../src/protocol/identity.ts";

const COPILOT_CLI_PATH = "/opt/homebrew/bin/copilot";
// The installer looks for a Copilot CLI on the real machine, which these tests must not depend on.
const discoverCli = async () => COPILOT_CLI_PATH;

let root: string;
let home: string;
let buildDirectory: string;
let messages: { log: string[]; error: string[] };
let hasSavedToken: Mock<() => Promise<boolean>>;
let forgetToken: Mock<() => Promise<boolean>>;

function writeBuild(label: string) {
  const nestedDirectory = join(buildDirectory, "resources", "nested");
  mkdirSync(nestedDirectory, { recursive: true });
  const executablePath = join(buildDirectory, COMPANION_EXECUTABLE_NAME);
  const nestedExecutablePath = join(nestedDirectory, "helper");
  writeFileSync(executablePath, `#!/bin/sh\necho '${label}'\n`);
  writeFileSync(nestedExecutablePath, "nested helper");
  writeFileSync(join(nestedDirectory, "data.bin"), "nested data");
  chmodSync(executablePath, 0o755);
  chmodSync(nestedExecutablePath, 0o755);
}

function install(overrides: Partial<Parameters<typeof runInstaller>[0]> = {}) {
  return runInstaller({
    args: [],
    platform: "darwin",
    home,
    buildDirectory,
    discoverCli,
    store: { hasSavedToken, forgetToken },
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
    ...overrides,
  });
}

function uninstall(options: string[] = [], confirm?: Confirm) {
  return install({ args: ["--uninstall", ...options], confirm });
}

function hostManifestCopies() {
  const hostManifestDirectory = dirname(companionInstallPaths(home).hostManifestPath);
  return existsSync(hostManifestDirectory) ? readdirSync(hostManifestDirectory).filter((entry) => entry.startsWith(".")) : [];
}

function runInstalledCompanion() {
  return spawnSync(companionInstallPaths(home).executablePath, { encoding: "utf8" }).stdout;
}

function makeBuildUncopyable() {
  const unreadableFile = join(buildDirectory, "unreadable");
  writeFileSync(unreadableFile, "");
  chmodSync(unreadableFile, 0o000);
  return () => rmSync(unreadableFile);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installer-"));
  home = join(root, "home");
  buildDirectory = join(root, "build");
  mkdirSync(home);
  writeBuild("first build");
  messages = { log: [], error: [] };
  hasSavedToken = vi.fn(async () => false);
  forgetToken = vi.fn(async () => false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("companionInstallPaths", () => {
  it("places the companion in Application Support and the host manifest where Chrome looks for it", () => {
    expect(companionInstallPaths("/Users/octocat")).toEqual({
      applicationDirectory: "/Users/octocat/Library/Application Support/prompt-harbor",
      companionDirectory: "/Users/octocat/Library/Application Support/prompt-harbor/companion",
      configPath: `/Users/octocat/Library/Application Support/prompt-harbor/${CONFIG_FILE_NAME}`,
      cacheDirectory: "/Users/octocat/Library/Caches/prompt-harbor/copilot-cli",
      executablePath: "/Users/octocat/Library/Application Support/prompt-harbor/companion/prompt-harbor-companion",
      hostManifestPath: `/Users/octocat/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    });
  });
});

describe("runInstaller", () => {
  it("copies the whole build, keeping its executables executable", async () => {
    await expect(install()).resolves.toBe(0);
    const { companionDirectory, executablePath } = companionInstallPaths(home);
    const nestedExecutablePath = join(companionDirectory, "resources", "nested", "helper");

    expect(runInstalledCompanion()).toBe("first build\n");
    expect(statSync(executablePath).mode & 0o777).toBe(0o755);
    expect(statSync(nestedExecutablePath).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dirname(nestedExecutablePath), "data.bin"), "utf8")).toBe("nested data");
  });

  it("records the Copilot CLI it found so the companion need not search on every start", async () => {
    await expect(install()).resolves.toBe(0);
    const { configPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ copilotCliPath: COPILOT_CLI_PATH });
  });

  it("still installs when no Copilot CLI is on this Mac, leaving the companion to look again", async () => {
    await expect(install({ discoverCli: async () => undefined })).resolves.toBe(0);
    const { configPath, executablePath } = companionInstallPaths(home);

    expect(existsSync(executablePath)).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("registers the installed copy with Chrome for the pinned extension only", async () => {
    await install();
    const { executablePath, hostManifestPath } = companionInstallPaths(home);

    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toEqual({
      name: HOST_NAME,
      description: "Local GitHub Copilot SDK companion for Prompt Harbor",
      path: executablePath,
      type: "stdio",
      allowed_origins: [EXTENSION_ORIGIN],
    });
    expect(statSync(hostManifestPath).mode & 0o777).toBe(0o644);
    expect(hostManifestCopies()).toEqual([]);
    expect(messages.log.join("\n")).toContain(executablePath);
    expect(messages.log.join("\n")).toContain(hostManifestPath);
    expect(messages.error).toEqual([]);
    expect(hasSavedToken).not.toHaveBeenCalled();
    expect(forgetToken).not.toHaveBeenCalled();
  });

  it("clears host manifest copies that an interrupted install left beside the manifest", async () => {
    const { hostManifestPath } = companionInstallPaths(home);
    const interruptedCopy = join(dirname(hostManifestPath), `.${HOST_NAME}.json.interrupted`);
    mkdirSync(dirname(hostManifestPath), { recursive: true });
    writeFileSync(interruptedCopy, "{");

    await expect(install()).resolves.toBe(0);
    expect(existsSync(interruptedCopy)).toBe(false);
    expect(JSON.parse(readFileSync(hostManifestPath, "utf8"))).toMatchObject({ name: HOST_NAME });
  });

  it("installs a copy that keeps working once the build is gone", async () => {
    await install();
    rmSync(buildDirectory, { recursive: true });

    expect(runInstalledCompanion()).toBe("first build\n");
  });

  it("replaces an earlier install completely and leaves no staging copies behind", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    writeFileSync(join(companionDirectory, "left-by-earlier-build"), "");
    writeBuild("second build");

    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("second build\n");
    expect(existsSync(join(companionDirectory, "left-by-earlier-build"))).toBe(false);
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("replaces the launcher that earlier versions installed in its place", async () => {
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(companionDirectory, `#!/bin/sh\nexec node checkout/src/companion/main.ts "$@"\n`);

    await expect(install()).resolves.toBe(0);
    expect(statSync(companionDirectory).isDirectory()).toBe(true);
    expect(runInstalledCompanion()).toBe("first build\n");
  });

  it("keeps the earlier install when copying a new build fails", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    writeBuild("second build");
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("puts the earlier companion back when the new host manifest cannot take the old one's place", async () => {
    await install();
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);
    rmSync(hostManifestPath);
    mkdirSync(join(hostManifestPath, "blocked"), { recursive: true });
    writeBuild("second build");

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
    expect(hostManifestCopies()).toEqual([]);
  });

  it("leaves nothing behind when a first install cannot copy the build", async () => {
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(existsSync(companionInstallPaths(home).applicationDirectory)).toBe(false);
    expect(existsSync(companionInstallPaths(home).hostManifestPath)).toBe(false);
  });

  it("leaves nothing behind when a first install cannot register with Chrome", async () => {
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);
    mkdirSync(join(hostManifestPath, "blocked"), { recursive: true });

    await expect(install()).rejects.toThrow();
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(hostManifestCopies()).toEqual([]);
  });

  it("puts back the companion that an interrupted install moved aside, even when the next copy fails", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    renameSync(companionDirectory, join(applicationDirectory, ".previous-interrupted"));
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    writeBuild("second build");
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("finishes the update that an interrupted install started", async () => {
    await install();
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    renameSync(companionDirectory, join(applicationDirectory, ".previous-interrupted"));
    writeBuild("second build");

    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("second build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("keeps companions moved aside while none is in place until a new copy is in place", async () => {
    const { applicationDirectory } = companionInstallPaths(home);
    mkdirSync(join(applicationDirectory, ".previous-one"), { recursive: true });
    mkdirSync(join(applicationDirectory, ".previous-two"));
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    const repairBuild = makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(readdirSync(applicationDirectory).sort()).toEqual([".previous-one", ".previous-two"]);

    repairBuild();
    await expect(install()).resolves.toBe(0);
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("clears copies that interrupted installs left beside an installed companion, even when the new copy fails", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    mkdirSync(join(applicationDirectory, ".staging-interrupted"));
    mkdirSync(join(applicationDirectory, ".previous-interrupted"));
    makeBuildUncopyable();

    await expect(install()).rejects.toThrow();
    expect(runInstalledCompanion()).toBe("first build\n");
    expect(readdirSync(applicationDirectory)).toEqual(["companion", CONFIG_FILE_NAME]);
  });

  it("refuses to install without a built companion, without touching the home directory", async () => {
    await expect(install({ buildDirectory: join(root, "never-built") })).resolves.toBe(1);
    expect(messages.error.join("\n")).toContain(join(root, "never-built"));
    expect(messages.error.join("\n")).toContain("pnpm companion:install");
    expect(readdirSync(home)).toEqual([]);
  });

  it("uninstalls the companion, its host manifest and the empty application directory, leaving other hosts alone", async () => {
    await install();
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);
    const otherHostManifest = join(dirname(hostManifestPath), "com.example.other_host.json");
    writeFileSync(otherHostManifest, "{}");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
    expect(existsSync(otherHostManifest)).toBe(true);
  });

  it("removes the cache the Copilot CLI unpacked its runtime into, leaving other caches alone", async () => {
    await install();
    const { cacheDirectory } = companionInstallPaths(home);
    const cachesDirectory = dirname(dirname(cacheDirectory));
    mkdirSync(join(cacheDirectory, "pkg", "darwin-arm64"), { recursive: true });
    writeFileSync(join(cacheDirectory, "pkg", "darwin-arm64", "runtime"), "unpacked runtime");
    const otherCache = join(cachesDirectory, "com.example.other");
    mkdirSync(otherCache, { recursive: true });
    writeFileSync(join(otherCache, "data"), "someone else's");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(cacheDirectory)).toBe(false);
    expect(existsSync(dirname(cacheDirectory))).toBe(false);
    expect(readFileSync(join(otherCache, "data"), "utf8")).toBe("someone else's");
    expect(existsSync(cachesDirectory)).toBe(true);
  });

  it("keeps a prompt-harbor cache directory that holds something else", async () => {
    await install();
    const { cacheDirectory } = companionInstallPaths(home);
    mkdirSync(cacheDirectory, { recursive: true });
    const siblingPath = join(dirname(cacheDirectory), "notes.txt");
    writeFileSync(siblingPath, "mine");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(cacheDirectory)).toBe(false);
    expect(readFileSync(siblingPath, "utf8")).toBe("mine");
  });

  it("uninstalls cleanly when the Copilot CLI never unpacked anything", async () => {
    await install();
    const { cacheDirectory } = companionInstallPaths(home);
    expect(existsSync(cacheDirectory)).toBe(false);

    await expect(uninstall()).resolves.toBe(0);
    expect(messages.error).toEqual([]);
  });

  it("keeps an application directory that holds other files", async () => {
    await install();
    const { applicationDirectory } = companionInstallPaths(home);
    writeFileSync(join(applicationDirectory, "notes.txt"), "mine");

    await expect(uninstall()).resolves.toBe(0);
    expect(readdirSync(applicationDirectory)).toEqual(["notes.txt"]);
  });

  it("uninstalls the launcher that earlier versions installed", async () => {
    const { applicationDirectory, companionDirectory } = companionInstallPaths(home);
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(companionDirectory, "#!/bin/sh\n");

    await expect(uninstall()).resolves.toBe(0);
    expect(existsSync(applicationDirectory)).toBe(false);
  });

  it("uninstalls cleanly when nothing is installed", async () => {
    await expect(uninstall()).resolves.toBe(0);
    expect(messages.error).toEqual([]);
  });

  it("removes stray host manifest copies when uninstalling", async () => {
    await install();
    const { hostManifestPath } = companionInstallPaths(home);
    writeFileSync(join(dirname(hostManifestPath), `.${HOST_NAME}.json.interrupted`), "{");

    await expect(uninstall()).resolves.toBe(0);
    expect(hostManifestCopies()).toEqual([]);
  });
});

describe("runInstaller and a saved PAT", () => {
  beforeEach(async () => {
    hasSavedToken.mockResolvedValue(true);
    forgetToken.mockResolvedValue(true);
    await install();
    messages = { log: [], error: [] };
  });

  it("asks before anything is removed, and deletes the saved PAT when the answer is yes", async () => {
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);
    const confirm = vi.fn(async (question: string) => {
      expect(question).toBe(SAVED_PAT_QUESTION);
      expect(existsSync(applicationDirectory)).toBe(true);
      expect(existsSync(hostManifestPath)).toBe(true);
      return true;
    });

    await expect(uninstall([], confirm)).resolves.toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(forgetToken).toHaveBeenCalledTimes(1);
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(messages.log).toEqual(["Removed the Prompt Harbor companion.", "Removed the saved PAT from your macOS login keychain."]);
    expect(messages.error).toEqual([]);
  });

  it("keeps the saved PAT when the answer is no, and says how to delete it later", async () => {
    await expect(uninstall([], async () => false)).resolves.toBe(0);
    expect(forgetToken).not.toHaveBeenCalled();
    expect(existsSync(companionInstallPaths(home).applicationDirectory)).toBe(false);
    expect(messages.log.join("\n")).toContain("Kept the PAT saved in your macOS login keychain.");
    expect(messages.log).toContain(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
    expect(messages.log.join("\n")).toContain(`delete the ${HOST_NAME} item in Keychain Access`);
  });

  it("keeps the saved PAT without asking when nobody can answer", async () => {
    await expect(uninstall()).resolves.toBe(0);
    expect(forgetToken).not.toHaveBeenCalled();
    expect(messages.log).toContain(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
  });

  it("keeps the saved PAT without asking when told to keep it", async () => {
    const confirm = vi.fn(async () => true);

    await expect(uninstall(["--keep-saved-pat"], confirm)).resolves.toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(forgetToken).not.toHaveBeenCalled();
    expect(messages.log).toContain(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
  });

  it("deletes the saved PAT without asking when told to delete it", async () => {
    const confirm = vi.fn(async () => false);

    await expect(uninstall(["--delete-saved-pat"], confirm)).resolves.toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(forgetToken).toHaveBeenCalledTimes(1);
    expect(messages.log).toContain("Removed the saved PAT from your macOS login keychain.");
  });

  it("neither asks nor deletes when the Keychain holds no saved PAT", async () => {
    hasSavedToken.mockResolvedValue(false);
    const confirm = vi.fn(async () => true);

    await expect(uninstall([], confirm)).resolves.toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(forgetToken).not.toHaveBeenCalled();
    expect(messages.log).toContain("No saved PAT was found in your macOS login keychain.");
  });

  it("still uninstalls, and says where to look, when the Keychain cannot be checked", async () => {
    hasSavedToken.mockRejectedValue(new Error("security failed"));

    await expect(uninstall([], async () => true)).resolves.toBe(0);
    expect(forgetToken).not.toHaveBeenCalled();
    expect(existsSync(companionInstallPaths(home).applicationDirectory)).toBe(false);
    expect(messages.error).toContain(`  ${DELETE_SAVED_TOKEN_COMMAND}`);
    expect(messages.error.join("\n")).toContain(`${HOST_NAME} item`);
    expect(messages.error.join("\n")).not.toContain("security failed");
  });

  it.each([
    ["times out", null],
    ["cannot ask for the keychain to be unlocked", 36],
  ])("does not claim there is no saved PAT when the real store's security tool %s", async (_description, exitCode) => {
    const runSecurity = vi.fn<SecurityRunner>(async () => ({ exitCode, output: "" }));
    const confirm = vi.fn(async () => true);

    await expect(install({ args: ["--uninstall"], store: createKeychainStore(runSecurity), confirm })).resolves.toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(runSecurity).toHaveBeenCalledTimes(1);
    expect(messages.log.join("\n")).not.toContain("No saved PAT was found");
    expect(messages.error[0]).toMatch(/^Could not check your macOS login keychain for a saved PAT/);
  });

  it("tells the real store's missing item apart from a failed check", async () => {
    const runSecurity = vi.fn<SecurityRunner>(async () => ({ exitCode: 44, output: "" }));

    await expect(install({ args: ["--uninstall"], store: createKeychainStore(runSecurity), confirm: async () => true })).resolves.toBe(0);
    expect(messages.log).toContain("No saved PAT was found in your macOS login keychain.");
    expect(messages.error).toEqual([]);
  });

  it("still removes the companion but fails with Keychain Access steps when the saved PAT cannot be removed", async () => {
    forgetToken.mockRejectedValue(new Error("security failed"));
    const { applicationDirectory, hostManifestPath } = companionInstallPaths(home);

    await expect(uninstall(["--delete-saved-pat"])).resolves.toBe(1);
    expect(existsSync(applicationDirectory)).toBe(false);
    expect(existsSync(hostManifestPath)).toBe(false);
    expect(messages.error.join("\n")).toContain("Keychain Access");
    expect(messages.error.join("\n")).toContain(HOST_NAME);
    expect(messages.error.join("\n")).not.toContain("security failed");
  });
});

describe("runInstaller arguments", () => {
  it.each([
    ["outside macOS", { platform: "linux" as const }, /macOS only/],
    ["with an unknown argument", { args: ["--force"] }, /Usage: pnpm companion:install/],
    ["with an unknown uninstall option", { args: ["--uninstall", "--force"] }, /--keep-saved-pat \| --delete-saved-pat/],
    ["with both saved PAT options", { args: ["--uninstall", "--keep-saved-pat", "--delete-saved-pat"] }, /Usage/],
  ])("refuses to run %s without touching the home directory", async (_description, overrides, message) => {
    await expect(install(overrides)).resolves.toBe(1);
    expect(messages.error.join("\n")).toMatch(message);
    expect(readdirSync(home)).toEqual([]);
    expect(hasSavedToken).not.toHaveBeenCalled();
    expect(forgetToken).not.toHaveBeenCalled();
  });
});

describe("createTerminalConfirm", () => {
  function terminal(isTTY: boolean) {
    const input = Object.assign(new PassThrough(), { isTTY });
    const output = Object.assign(new PassThrough(), { isTTY });
    let shown = "";
    output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
    return { input, output, shown: () => shown };
  }

  it("offers no way to ask unless both input and output are a terminal", () => {
    expect(createTerminalConfirm(terminal(false).input, terminal(true).output)).toBeUndefined();
    expect(createTerminalConfirm(terminal(true).input, terminal(false).output)).toBeUndefined();
  });

  it.each([
    ["y\n", true],
    ["Yes\n", true],
    ["\n", false],
    ["no\n", false],
    ["yep\n", false],
  ])("treats the answer %j as %s", async (answer, expected) => {
    const { input, output, shown } = terminal(true);
    const confirm = createTerminalConfirm(input, output);
    const confirmed = confirm?.("Delete it too? [y/N] ");
    input.write(answer);

    await expect(confirmed).resolves.toBe(expected);
    expect(shown()).toBe("Delete it too? [y/N] ");
  });

  it("treats input that ends without an answer as no", async () => {
    const { input, output } = terminal(true);
    const confirmed = createTerminalConfirm(input, output)?.("Delete it too? [y/N] ");
    input.end();

    await expect(confirmed).resolves.toBe(false);
  });
});
