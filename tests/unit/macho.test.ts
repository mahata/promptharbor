import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMachOSummary, readMachOSummary } from "../../src/companion/macho.ts";

const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
const PLATFORM_IOS = 2;

type LoadCommand = { command: number; words: number[] };

function encodeVersion(major: number, minor: number, patch = 0) {
  return (major << 16) | (minor << 8) | patch;
}

function machO(cpuType: number, loadCommands: LoadCommand[], magic = 0xfeedfacf) {
  const commands = loadCommands.map(({ command, words }) => {
    const buffer = Buffer.alloc(8 + words.length * 4);
    buffer.writeUInt32LE(command, 0);
    buffer.writeUInt32LE(buffer.length, 4);
    words.forEach((word, index) => buffer.writeUInt32LE(word >>> 0, 8 + index * 4));
    return buffer;
  });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(commands.reduce((total, command) => total + command.length, 0), 20);
  return Buffer.concat([header, ...commands]);
}

function buildVersion(platform: number, minimum: number) {
  return { command: LC_BUILD_VERSION, words: [platform, minimum, encodeVersion(15, 0), 0] };
}

const segment = { command: LC_SEGMENT_64, words: new Array<number>(16).fill(0) };

describe("parseMachOSummary", () => {
  it("reads the architecture and the minimum macOS version from LC_BUILD_VERSION", () => {
    expect(parseMachOSummary(machO(CPU_TYPE_ARM64, [segment, buildVersion(PLATFORM_MACOS, encodeVersion(13, 5))]))).toEqual({
      arch: "arm64",
      minimumMacOSVersion: "13.5",
    });
    expect(parseMachOSummary(machO(CPU_TYPE_X86_64, [buildVersion(PLATFORM_MACOS, encodeVersion(10, 15, 4))]))).toEqual({
      arch: "x64",
      minimumMacOSVersion: "10.15.4",
    });
  });

  it("reads the older LC_VERSION_MIN_MACOSX", () => {
    const image = machO(CPU_TYPE_X86_64, [{ command: LC_VERSION_MIN_MACOSX, words: [encodeVersion(11, 0), encodeVersion(12, 0)] }]);
    expect(parseMachOSummary(image).minimumMacOSVersion).toBe("11.0");
  });

  it("skips build versions for other platforms", () => {
    const image = machO(CPU_TYPE_ARM64, [buildVersion(PLATFORM_IOS, encodeVersion(17, 0)), buildVersion(PLATFORM_MACOS, encodeVersion(14, 0))]);
    expect(parseMachOSummary(image).minimumMacOSVersion).toBe("14.0");
  });

  it.each([
    ["a universal binary", machO(CPU_TYPE_ARM64, [], 0xbebafeca), /not a 64-bit Mach-O file/],
    ["a script", Buffer.from("#!/bin/sh\necho hello, this is not a binary\n"), /not a 64-bit Mach-O file/],
    ["another architecture", machO(0x00000012, [buildVersion(PLATFORM_MACOS, encodeVersion(13, 0))]), /arm64 or x86_64/],
    ["no minimum macOS version", machO(CPU_TYPE_ARM64, [segment]), /minimum macOS version/],
    ["a truncated load command", machO(CPU_TYPE_ARM64, [buildVersion(PLATFORM_MACOS, encodeVersion(13, 0))]).subarray(0, 40), /minimum macOS version/],
  ])("rejects %s", (_description, image, message) => {
    expect(() => parseMachOSummary(image, "The file")).toThrow(message);
  });
});

describe("readMachOSummary", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "macho-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("reads only the header and load commands of a file", async () => {
    const path = join(directory, "binary");
    writeFileSync(path, Buffer.concat([machO(CPU_TYPE_ARM64, [buildVersion(PLATFORM_MACOS, encodeVersion(13, 5))]), Buffer.alloc(4096, 0xff)]));
    await expect(readMachOSummary(path)).resolves.toEqual({ arch: "arm64", minimumMacOSVersion: "13.5" });
  });

  it("names the file it cannot read", async () => {
    const path = join(directory, "tiny");
    writeFileSync(path, "#!");
    await expect(readMachOSummary(path)).rejects.toThrow(`${path} is not a 64-bit Mach-O file`);
  });
});

