import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGE_CONTENT_SECURITY_POLICY, PRIVACY_PAGE_PATH, renderPrivacyPage, runSiteBuilder } from "../../src/site/build.ts";

const repositoryPolicyPath = fileURLToPath(new URL("../../PRIVACY.md", import.meta.url));

const policy = [
  "# Example Privacy Policy",
  "",
  "Read the [statement](https://example.com/statement), or write to <mailto:privacy@example.com>.",
  "",
  "## What is kept",
  "",
  "- Your `token`, in the keychain.",
  "",
].join("\n");

let root: string;
let policyPath: string;
let outputDirectory: string;
let messages: { log: string[]; error: string[] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "site-build-"));
  policyPath = join(root, "PRIVACY.md");
  outputDirectory = join(root, "dist-site");
  messages = { log: [], error: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildSite() {
  return runSiteBuilder({
    policyPath,
    outputDirectory,
    output: { log: (line) => messages.log.push(line), error: (line) => messages.error.push(line) },
  });
}

function builtFiles() {
  return readdirSync(outputDirectory, { recursive: true, encoding: "utf8" }).sort();
}

describe("privacy policy page", () => {
  it("renders the policy as a standalone English page titled by its top-level heading", () => {
    const page = renderPrivacyPage(policy);

    expect(page).toMatch(/^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n/);
    expect(page).toContain("<title>Example Privacy Policy</title>");
    expect(page).toContain("<h1>Example Privacy Policy</h1>");
    expect(page).toContain("<h2>What is kept</h2>");
    expect(page).toContain('<a href="https://example.com/statement">statement</a>');
    expect(page).toContain('<a href="mailto:privacy@example.com">');
    expect(page).toContain("<li>Your <code>token</code>, in the keychain.</li>");
  });

  it("escapes the title, keeping entities the policy spells out", () => {
    expect(renderPrivacyPage("# Terms & `<code>` &amp; *you*\n")).toContain("<title>Terms &amp; &lt;code&gt; &amp; you</title>");
  });

  it("loads nothing and runs nothing, allowing only its own inline style", () => {
    const page = renderPrivacyPage(policy);
    const style = /<style>([\s\S]*)<\/style>/.exec(page)?.[1] ?? "";

    expect(PAGE_CONTENT_SECURITY_POLICY.split("; ")).toEqual([
      "default-src 'none'",
      `style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`,
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CONTENT_SECURITY_POLICY}">`;
    expect(page.indexOf(policyMeta)).toBeGreaterThan(-1);
    expect(page.indexOf(policyMeta)).toBeLessThan(page.indexOf("<style>"));
    expect(page).not.toContain("<script");
  });

  it.each(["README.md", "#boundaries", "./docs/privacy.md", "/promptharbor/", "http://example.com/"])(
    "refuses a link to %s, which cannot work both on GitHub and on GitHub Pages",
    (href) => {
      expect(() => renderPrivacyPage(`# Policy\n\nSee [this](${href}).\n`)).toThrow(JSON.stringify(href));
    },
  );

  it("refuses an image with a relative source", () => {
    expect(() => renderPrivacyPage("# Policy\n\n![Data flow](data-flow.png)\n")).toThrow('"data-flow.png"');
  });

  it("refuses a policy without a top-level heading to title the page", () => {
    expect(() => renderPrivacyPage("## Policy\n\nText.\n")).toThrow("top-level heading");
  });

  it("publishes the repository's PRIVACY.md", () => {
    expect(renderPrivacyPage(readFileSync(repositoryPolicyPath, "utf8"))).toContain("<title>Prompt Harbor Privacy Policy</title>");
  });
});

describe("privacy policy site build", () => {
  it("keeps the page at privacy/index.html, the path the Chrome Web Store listing links to", () => {
    expect(PRIVACY_PAGE_PATH).toBe("privacy/index.html");
  });

  it("writes only the page, replacing an earlier build completely", async () => {
    writeFileSync(policyPath, policy);
    mkdirSync(join(outputDirectory, "stale"), { recursive: true });
    writeFileSync(join(outputDirectory, "stale", "index.html"), "<p>stale</p>");

    expect(await buildSite()).toBe(0);

    expect(builtFiles()).toEqual(["privacy", join("privacy", "index.html")]);
    expect(readFileSync(join(outputDirectory, PRIVACY_PAGE_PATH), "utf8")).toBe(renderPrivacyPage(policy));
    expect(messages.log).toContain(`  ${join(outputDirectory, PRIVACY_PAGE_PATH)}`);
    expect(messages.error).toEqual([]);
  });

  it("keeps the earlier build when the policy cannot be published", async () => {
    writeFileSync(policyPath, policy);
    expect(await buildSite()).toBe(0);
    writeFileSync(policyPath, "# Policy\n\nSee [the README](README.md).\n");

    expect(await buildSite()).toBe(1);

    expect(messages.error.join("\n")).toContain('"README.md"');
    expect(readFileSync(join(outputDirectory, PRIVACY_PAGE_PATH), "utf8")).toBe(renderPrivacyPage(policy));
  });

  it("explains a missing policy and writes nothing", async () => {
    expect(await buildSite()).toBe(1);

    expect(messages.error.join("\n")).toContain(policyPath);
    expect(existsSync(outputDirectory)).toBe(false);
  });
});
