import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWebStorePackager, webStoreManifest, webStorePackageFileName } from "../../src/webstore/package.ts";

const builtManifest = {
  manifest_version: 3,
  name: "Prompt Harbor",
  version: "1.2.3",
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
  permissions: ["sidePanel", "nativeMessaging"],
};
const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);

let root: string;
let extensionDirectory: string;
let outputDirectory: string;
let messages: { log: string[]; error: string[] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webstore-package-"));
  extensionDirectory = join(root, "dist");
  outputDirectory = join(root, "dist-webstore");
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBuildFile(relativePath: string, content: string | Buffer) {
  const path = join(extensionDirectory, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeBuild(manifest: Record<string, unknown> = builtManifest) {
  writeBuildFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  writeBuildFile("sidepanel.html", "<!doctype html>");
  writeBuildFile("background.js", "export {};");
  writeBuildFile("assets/sidepanel.js", "console.log('panel');");
  writeBuildFile("icons/icon-128.png", iconBytes);
}

function packageExtension() {
  return runWebStorePackager({
    extensionDirectory,
    outputDirectory,
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
  });
}

function archiveEntries(archivePath: string) {
  const listing = spawnSync("zipinfo", ["-1", archivePath], { encoding: "utf8" });
  expect(listing.status).toBe(0);
  return listing.stdout.trim().split("\n").sort();
}

function archivedFile(archivePath: string, entry: string) {
  const extraction = spawnSync("unzip", ["-p", archivePath, entry]);
  expect(extraction.status).toBe(0);
  return extraction.stdout;
}

describe("Chrome Web Store package", () => {
  it("drops the manifest key, which the Chrome Web Store refuses, and keeps everything else", () => {
    const manifest = { ...builtManifest };
    const { key, ...manifestWithoutKey } = builtManifest;

    expect(webStoreManifest(manifest)).toEqual(manifestWithoutKey);
    expect(manifest.key).toBe(key);
  });

  it("names the archive after the extension version", () => {
    expect(webStorePackageFileName("0.1.0")).toBe("prompt-harbor-0.1.0.zip");
  });

  it("zips the build with its manifest at the root and without the key", async () => {
    writeBuild();

    expect(await packageExtension()).toBe(0);

    const archivePath = join(outputDirectory, "prompt-harbor-1.2.3.zip");
    expect(archiveEntries(archivePath)).toEqual([
      "assets/sidepanel.js",
      "background.js",
      "icons/icon-128.png",
      "manifest.json",
      "sidepanel.html",
    ]);
    const archivedManifest: Record<string, unknown> = JSON.parse(archivedFile(archivePath, "manifest.json").toString("utf8"));
    expect(archivedManifest).not.toHaveProperty("key");
    expect(archivedManifest).toEqual(webStoreManifest(builtManifest));
    expect(archivedFile(archivePath, "icons/icon-128.png")).toEqual(iconBytes);
    expect(messages.log).toContain(`  ${archivePath}`);
    expect(messages.error).toEqual([]);
  });

  it("leaves the build's own manifest and its key alone, for loading unpacked", async () => {
    writeBuild();
    const manifestBefore = readFileSync(join(extensionDirectory, "manifest.json"), "utf8");

    expect(await packageExtension()).toBe(0);

    expect(readFileSync(join(extensionDirectory, "manifest.json"), "utf8")).toBe(manifestBefore);
  });

  it("replaces an earlier archive of the same version completely and leaves nothing else behind", async () => {
    writeBuild();
    writeBuildFile("assets/stale.js", "console.log('stale');");
    expect(await packageExtension()).toBe(0);
    rmSync(join(extensionDirectory, "assets/stale.js"));

    expect(await packageExtension()).toBe(0);

    expect(archiveEntries(join(outputDirectory, "prompt-harbor-1.2.3.zip"))).not.toContain("assets/stale.js");
    expect(readdirSync(outputDirectory)).toEqual(["prompt-harbor-1.2.3.zip"]);
  });

  it("clears the staging copy an interrupted run left behind", async () => {
    writeBuild();
    mkdirSync(join(outputDirectory, ".webstore-staging-interrupted", "extension"), { recursive: true });

    expect(await packageExtension()).toBe(0);

    expect(readdirSync(outputDirectory)).toEqual(["prompt-harbor-1.2.3.zip"]);
  });

  it("explains how to build the extension first when there is no build", async () => {
    expect(await packageExtension()).toBe(1);

    expect(messages.error.join("\n")).toContain("pnpm webstore:package");
    expect(existsSync(join(outputDirectory, "prompt-harbor-1.2.3.zip"))).toBe(false);
  });

  it.each(["1.2.3-beta", "1.2.3.4.5", "../1.2.3", "01.2.3", "65536.0", "0.0.0"])("refuses version %s, which Chrome does not accept", async (version) => {
    writeBuild({ ...builtManifest, version });

    expect(await packageExtension()).toBe(1);

    expect(messages.error.join("\n")).toContain(version);
    expect(existsSync(outputDirectory) ? readdirSync(outputDirectory) : []).toEqual([]);
  });
});
