import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWebStorePackager } from "./package.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

process.exitCode = await runWebStorePackager({
  extensionDirectory: join(repositoryRoot, "dist"),
  outputDirectory: join(repositoryRoot, "dist-webstore"),
  output: console,
});
