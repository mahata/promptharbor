import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSiteBuilder } from "./build.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

process.exitCode = await runSiteBuilder({
  policyPath: join(repositoryRoot, "PRIVACY.md"),
  outputDirectory: join(repositoryRoot, "dist-site"),
  output: console,
});
