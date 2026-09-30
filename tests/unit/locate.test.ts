import { describe, expect, it } from "vitest";
import { copilotCliCandidates, discoverCopilotCli } from "../../src/companion/locate.ts";

const HOME = "/Users/octocat";
// What Chrome gives the companion, which is why the candidate list has to do the work.
const CHROME_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function found(...paths: string[]) {
  const executables = new Set(paths);
  return async (path: string) => executables.has(path);
}

describe("copilotCliCandidates", () => {
  it("looks where the Copilot CLI is normally installed, which Chrome's PATH never covers", () => {
    const candidates = copilotCliCandidates({ home: HOME, pathVariable: CHROME_PATH });

    expect(candidates).toContain("/opt/homebrew/bin/copilot");
    expect(candidates).toContain("/usr/local/bin/copilot");
    expect(candidates).toContain(`${HOME}/.local/bin/copilot`);
    expect(candidates).toContain(`${HOME}/.npm-global/bin/copilot`);
  });

  it("searches the PATH it was given as well", () => {
    expect(copilotCliCandidates({ home: HOME, pathVariable: "/opt/tools/bin" })).toContain("/opt/tools/bin/copilot");
  });

  it("ignores relative PATH entries, which are not safe to run", () => {
    expect(copilotCliCandidates({ home: HOME, pathVariable: "relative/bin" })).not.toContain("relative/bin/copilot");
  });

  it("lists each candidate once, so a directory named twice is searched once", () => {
    const candidates = copilotCliCandidates({ home: HOME, pathVariable: "/opt/homebrew/bin:/opt/homebrew/bin" });

    expect(candidates.filter((candidate) => candidate === "/opt/homebrew/bin/copilot")).toHaveLength(1);
  });
});

describe("discoverCopilotCli", () => {
  it("finds a Homebrew install even though Chrome's PATH does not mention it", async () => {
    const options = { home: HOME, pathVariable: CHROME_PATH, isExecutable: found("/opt/homebrew/bin/copilot") };

    await expect(discoverCopilotCli(options)).resolves.toBe("/opt/homebrew/bin/copilot");
  });

  it("keeps the stable Homebrew link rather than the versioned file it points at", async () => {
    const options = {
      home: HOME,
      pathVariable: CHROME_PATH,
      isExecutable: found("/opt/homebrew/bin/copilot", "/opt/homebrew/Caskroom/copilot-cli/0.0.395/copilot"),
    };

    await expect(discoverCopilotCli(options)).resolves.toBe("/opt/homebrew/bin/copilot");
  });

  it("uses a pinned path rather than one it would otherwise find", async () => {
    const options = {
      home: HOME,
      pathVariable: CHROME_PATH,
      override: "/opt/pinned/copilot",
      isExecutable: found("/opt/pinned/copilot", "/opt/homebrew/bin/copilot"),
    };

    await expect(discoverCopilotCli(options)).resolves.toBe("/opt/pinned/copilot");
  });

  it("reports nothing when a pinned path has gone, rather than quietly running another Copilot CLI", async () => {
    const options = {
      home: HOME,
      pathVariable: CHROME_PATH,
      override: "/opt/pinned/copilot",
      isExecutable: found("/usr/local/bin/copilot"),
    };

    await expect(discoverCopilotCli(options)).resolves.toBeUndefined();
  });

  it("ignores a relative pin, which is not safe to run", async () => {
    const options = { home: HOME, pathVariable: CHROME_PATH, override: "copilot", isExecutable: found("copilot") };

    await expect(discoverCopilotCli(options)).resolves.toBeUndefined();
  });

  it("reports nothing when no Copilot CLI is installed", async () => {
    const options = { home: HOME, pathVariable: CHROME_PATH, isExecutable: found() };

    await expect(discoverCopilotCli(options)).resolves.toBeUndefined();
  });
});
