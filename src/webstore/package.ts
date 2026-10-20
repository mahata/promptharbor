import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ZIP_PATH = "/usr/bin/zip";
const MANIFEST_FILE_NAME = "manifest.json";
const STAGING_PREFIX = ".webstore-staging-";
const STAGED_EXTENSION_DIRECTORY = "extension";
const STAGED_ARCHIVE_NAME = "extension.zip";
const VERSION_PATTERN = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/;
const MAX_VERSION_PART = 65_535;
const SUCCESS = 0;
const FAILURE = 1;

type Manifest = Readonly<Record<string, unknown>>;

export type WebStorePackagerOptions = {
  extensionDirectory: string;
  outputDirectory: string;
  output: { log: (line: string) => void; error: (line: string) => void };
};

class WebStorePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebStorePackageError";
  }
}

export function webStorePackageFileName(version: string) {
  return `prompt-harbor-${version}.zip`;
}

// The Chrome Web Store refuses a manifest with a key. It signs the extension with a key of its own,
// which sets the published extension's ID.
export function webStoreManifest(manifest: Manifest) {
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  return storeManifest;
}

export async function runWebStorePackager({ extensionDirectory, outputDirectory, output }: WebStorePackagerOptions) {
  try {
    const manifest = await readBuiltManifest(extensionDirectory);
    const version = chromeVersion(manifest);
    const archivePath = await buildWebStorePackage({ extensionDirectory, outputDirectory, manifest, version });
    output.log(`Built the Chrome Web Store package for Prompt Harbor ${version}:`);
    output.log(`  ${archivePath}`);
    output.log("Its manifest leaves out the key, which the Chrome Web Store refuses.");
    return SUCCESS;
  } catch (error) {
    if (!(error instanceof WebStorePackageError)) throw error;
    output.error(error.message);
    return FAILURE;
  }
}

async function buildWebStorePackage({
  extensionDirectory,
  outputDirectory,
  manifest,
  version,
}: {
  extensionDirectory: string;
  outputDirectory: string;
  manifest: Manifest;
  version: string;
}) {
  await mkdir(outputDirectory, { recursive: true });
  await removeStaleStagingDirectories(outputDirectory);
  const staging = await mkdtemp(join(outputDirectory, STAGING_PREFIX));
  try {
    const stagedExtension = join(staging, STAGED_EXTENSION_DIRECTORY);
    const stagedArchive = join(staging, STAGED_ARCHIVE_NAME);
    await cp(extensionDirectory, stagedExtension, { recursive: true });
    await writeFile(join(stagedExtension, MANIFEST_FILE_NAME), `${JSON.stringify(webStoreManifest(manifest), null, 2)}\n`);
    zipDirectoryContents(stagedExtension, stagedArchive);
    const archivePath = join(outputDirectory, webStorePackageFileName(version));
    await rename(stagedArchive, archivePath);
    return archivePath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Zipping from inside the directory puts manifest.json at the root of the archive, where the
// Chrome Web Store looks for it. -D leaves out directory entries and -X file system extras.
function zipDirectoryContents(directory: string, archivePath: string) {
  const { status, stderr, error } = spawnSync(ZIP_PATH, ["-q", "-r", "-D", "-X", archivePath, "."], { cwd: directory, encoding: "utf8" });
  if (status === SUCCESS) return;
  const detail = error?.message ?? stderr.trim();
  throw new WebStorePackageError(`${basename(ZIP_PATH)} could not create ${archivePath}${detail ? `:\n${detail}` : "."}`);
}

async function readBuiltManifest(extensionDirectory: string): Promise<Manifest> {
  const manifestPath = join(extensionDirectory, MANIFEST_FILE_NAME);
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    throw new WebStorePackageError(`No extension build was found in ${extensionDirectory}. Run pnpm webstore:package, which builds it first.`);
  }
  const manifest: unknown = JSON.parse(manifestText);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new WebStorePackageError(`${manifestPath} does not hold a manifest object.`);
  }
  return manifest as Manifest;
}

function chromeVersion({ version }: Manifest) {
  if (typeof version === "string" && isChromeVersion(version)) return version;
  throw new WebStorePackageError(
    `The manifest version ${JSON.stringify(version)} is not one Chrome accepts: one to four dot-separated integers ` +
      `from 0 to ${MAX_VERSION_PART}, without leading zeros and not all zero.`,
  );
}

function isChromeVersion(version: string) {
  if (!VERSION_PATTERN.test(version)) return false;
  const parts = version.split(".").map(Number);
  return parts.every((part) => part <= MAX_VERSION_PART) && parts.some((part) => part > 0);
}

async function removeStaleStagingDirectories(outputDirectory: string) {
  for (const entry of await readdir(outputDirectory)) {
    if (entry.startsWith(STAGING_PREFIX)) await rm(join(outputDirectory, entry), { recursive: true, force: true });
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
