import { open } from "node:fs/promises";

const MACH_HEADER_64_SIZE = 32;
const MAX_LOAD_COMMANDS_SIZE = 1024 * 1024;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;
const LOAD_COMMAND_HEADER_SIZE = 8;
const CPU_TYPES: Readonly<Record<number, string>> = { 0x0100000c: "arm64", 0x01000007: "x64" };

export type MachOSummary = { arch: string; minimumMacOSVersion: string };

export async function readMachOSummary(path: string): Promise<MachOSummary> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(MACH_HEADER_64_SIZE);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < MACH_HEADER_64_SIZE || header.readUInt32LE(0) !== MH_MAGIC_64) return parseMachOSummary(header, path);
    const image = Buffer.alloc(MACH_HEADER_64_SIZE + Math.min(header.readUInt32LE(20), MAX_LOAD_COMMANDS_SIZE));
    await file.read(image, 0, image.length, 0);
    return parseMachOSummary(image, path);
  } finally {
    await file.close();
  }
}

// Reads a thin 64-bit little-endian Mach-O image, which is what Node.js and the Copilot runtime ship
// for each Mac architecture. `image` needs to hold the header and its load commands.
export function parseMachOSummary(image: Buffer, name = "The file"): MachOSummary {
  if (image.length < MACH_HEADER_64_SIZE || image.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error(`${name} is not a 64-bit Mach-O file for a single architecture.`);
  }
  const arch = CPU_TYPES[image.readUInt32LE(4)];
  if (arch === undefined) throw new Error(`${name} is not built for arm64 or x86_64.`);
  const loadCommandCount = image.readUInt32LE(16);
  const loadCommandsEnd = Math.min(image.length, MACH_HEADER_64_SIZE + image.readUInt32LE(20));
  let offset = MACH_HEADER_64_SIZE;
  for (let index = 0; index < loadCommandCount && offset + LOAD_COMMAND_HEADER_SIZE <= loadCommandsEnd; index += 1) {
    const command = image.readUInt32LE(offset);
    const commandSize = image.readUInt32LE(offset + 4);
    if (commandSize < LOAD_COMMAND_HEADER_SIZE || offset + commandSize > loadCommandsEnd) break;
    if (command === LC_BUILD_VERSION && commandSize >= 16 && image.readUInt32LE(offset + 8) === PLATFORM_MACOS) {
      return { arch, minimumMacOSVersion: formatVersion(image.readUInt32LE(offset + 12)) };
    }
    if (command === LC_VERSION_MIN_MACOSX && commandSize >= 12) {
      return { arch, minimumMacOSVersion: formatVersion(image.readUInt32LE(offset + 8)) };
    }
    offset += commandSize;
  }
  throw new Error(`${name} does not declare a minimum macOS version.`);
}

// Mach-O packs versions as xxxx.yy.zz in 16, 8 and 8 bits.
function formatVersion(encoded: number) {
  const major = encoded >>> 16;
  const minor = (encoded >>> 8) & 0xff;
  const patch = encoded & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}
