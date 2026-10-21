import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Lexer, Parser, marked } from "marked";
import type { Token, Tokens } from "marked";

export const PRIVACY_PAGE_PATH = "privacy/index.html";
const ALLOWED_LINK_PROTOCOLS = new Set(["https:", "mailto:"]);
const SUCCESS = 0;
const FAILURE = 1;

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { box-sizing: border-box; max-width: 48rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1, h2 { line-height: 1.25; }
h2 { margin-top: 2.5rem; }
li + li { margin-top: 0.5rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875em; overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 0.75rem 1rem; border-radius: 6px; background: rgb(128 128 128 / 0.12); }
pre code { overflow-wrap: normal; }
:not(pre) > code { padding: 0.1em 0.3em; border-radius: 4px; background: rgb(128 128 128 / 0.12); }
`;

// The page loads nothing and runs nothing: only its own inline style, pinned by hash.
export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type SiteBuilderOptions = {
  policyPath: string;
  outputDirectory: string;
  output: { log: (line: string) => void; error: (line: string) => void };
};

class SiteBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteBuildError";
  }
}

export async function runSiteBuilder({ policyPath, outputDirectory, output }: SiteBuilderOptions) {
  try {
    const page = renderPrivacyPage(await readPolicy(policyPath));
    const pagePath = join(outputDirectory, PRIVACY_PAGE_PATH);
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(dirname(pagePath), { recursive: true });
    await writeFile(pagePath, page);
    output.log("Built the privacy policy page for GitHub Pages:");
    output.log(`  ${pagePath}`);
    return SUCCESS;
  } catch (error) {
    if (!(error instanceof SiteBuildError)) throw error;
    output.error(error.message);
    return FAILURE;
  }
}

export function renderPrivacyPage(markdown: string) {
  const tokens = Lexer.lex(markdown, { gfm: true });
  const title = pageTitle(tokens);
  refuseRelativeLinks(tokens);
  return pageDocument(title, Parser.parse(tokens, { gfm: true }));
}

function pageDocument(title: string, body: string) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CONTENT_SECURITY_POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    body.trimEnd(),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function pageTitle(tokens: readonly Token[]) {
  const heading = tokens.find((token): token is Tokens.Heading => token.type === "heading" && token.depth === 1);
  const title = heading && titleText(heading.tokens).trim();
  if (!title) throw new SiteBuildError("The privacy policy has no top-level heading (# …) to use as the page title.");
  return title;
}

// Token text is the Markdown source, so plain text may hold entities its author typed, while
// escapes and code spans are literal characters.
function titleText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
          return escapeHtml(token.text, { keepEntities: true });
        case "escape":
        case "codespan":
          return escapeHtml(token.text, { keepEntities: false });
        case "html":
          return "";
        default:
          return "tokens" in token && token.tokens ? titleText(token.tokens) : "";
      }
    })
    .join("");
}

// The same file is read on GitHub and published on GitHub Pages, and a relative link cannot work
// in both places.
function refuseRelativeLinks(tokens: Token[]) {
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "link" && token.type !== "image") return;
    const { href } = token as Tokens.Link | Tokens.Image;
    if (URL.canParse(href) && ALLOWED_LINK_PROTOCOLS.has(new URL(href).protocol)) return;
    throw new SiteBuildError(
      `The privacy policy links to ${JSON.stringify(href)}. Use an absolute https: or mailto: link, because the policy ` +
        "is read both on GitHub and on GitHub Pages.",
    );
  });
}

async function readPolicy(policyPath: string) {
  try {
    return await readFile(policyPath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    throw new SiteBuildError(`No privacy policy was found at ${policyPath}.`);
  }
}

function escapeHtml(text: string, { keepEntities }: { keepEntities: boolean }) {
  return text
    .replace(keepEntities ? /&(?!#?\w+;)/g : /&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
