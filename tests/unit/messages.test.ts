import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_LENGTH,
  MAX_PAGE_SELECTION_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MAX_PAGE_URL_LENGTH,
  MAX_PROMPT_LENGTH,
  PROTOCOL_VERSION,
  isFineGrainedPersonalAccessToken,
  parseCompanionMessage,
  parsePanelMessage,
} from "../../src/protocol/messages.ts";

const validToken = `github_pat_${"A1b2_".repeat(16)}`;

describe("fine-grained personal access token format", () => {
  it("accepts the github_pat_ prefix with token characters", () => {
    expect(isFineGrainedPersonalAccessToken(validToken)).toBe(true);
  });

  it.each([
    ["a classic token", `ghp_${"a".repeat(36)}`],
    ["an OAuth token", `gho_${"a".repeat(36)}`],
    ["an empty string", ""],
    ["the bare prefix", "github_pat_"],
    ["surrounding whitespace", ` ${validToken} `],
    ["an embedded newline", `github_pat_abc\ndef`],
    ["more than 255 characters", `github_pat_${"a".repeat(245)}`],
  ])("rejects %s", (_description, token) => {
    expect(isFineGrainedPersonalAccessToken(token)).toBe(false);
  });
});

describe("panel to companion messages", () => {
  it.each([
    { type: "connect", token: validToken, remember: true },
    { type: "connect", token: validToken, remember: false },
    { type: "connect_saved" },
    { type: "send", model: "gpt-5-mini", prompt: "Explain closures in JavaScript." },
    { type: "send", model: "gpt-5-mini", prompt: "  Keep my indentation:\n\tconst answer = 42;\n" },
    { type: "stop" },
    { type: "new_chat" },
    { type: "forget" },
  ])("accepts %j", (message) => {
    expect(parsePanelMessage(message)).toEqual(message);
  });

  it.each([
    { url: "https://example.com/", title: "Example", text: "Body", truncated: false },
    { url: "https://example.com/", title: "", text: "", truncated: false },
    { url: "https://example.com/", title: "Example", text: "Body", selection: "Bo", truncated: true },
    {
      url: "u".repeat(MAX_PAGE_URL_LENGTH),
      title: "t".repeat(MAX_PAGE_TITLE_LENGTH),
      text: "x".repeat(MAX_PAGE_TEXT_LENGTH),
      selection: "s".repeat(MAX_PAGE_SELECTION_LENGTH),
      truncated: true,
    },
  ])("accepts a send with page %#", (page) => {
    const message = { type: "send", model: "gpt-5-mini", prompt: "Summarize", page };
    expect(parsePanelMessage(message)).toEqual(message);
  });

  const page = { url: "https://example.com/", title: "Example", text: "Body", truncated: false };
  it.each([
    ["a non-object page", "https://example.com/"],
    ["an empty URL", { ...page, url: "" }],
    ["an oversized URL", { ...page, url: "u".repeat(MAX_PAGE_URL_LENGTH + 1) }],
    ["an oversized title", { ...page, title: "t".repeat(MAX_PAGE_TITLE_LENGTH + 1) }],
    ["an oversized text", { ...page, text: "x".repeat(MAX_PAGE_TEXT_LENGTH + 1) }],
    ["an empty selection", { ...page, selection: "" }],
    ["an oversized selection", { ...page, selection: "s".repeat(MAX_PAGE_SELECTION_LENGTH + 1) }],
    ["a missing truncated flag", { url: page.url, title: page.title, text: page.text }],
    ["a non-string text", { ...page, text: 5 }],
    ["an extra page field", { ...page, html: "<p>Body</p>" }],
  ])("rejects a send with %s", (_description, value) => {
    expect(parsePanelMessage({ type: "send", model: "gpt-5-mini", prompt: "Summarize", page: value })).toBeUndefined();
  });

  it("accepts a prompt at the length limit", () => {
    const message = { type: "send", model: "gpt-5-mini", prompt: "p".repeat(MAX_PROMPT_LENGTH) };
    expect(parsePanelMessage(message)).toEqual(message);
  });

  it.each([
    ["a non-object", "connect"],
    ["null", null],
    ["an array", [{ type: "stop" }]],
    ["an unknown type", { type: "prompt", text: "hi" }],
    ["a classic token", { type: "connect", token: `ghp_${"a".repeat(36)}`, remember: false }],
    ["a missing token", { type: "connect", remember: false }],
    ["a missing remember choice", { type: "connect", token: validToken }],
    ["a remember choice that is not a boolean", { type: "connect", token: validToken, remember: "yes" }],
    ["an extra connect field", { type: "connect", token: validToken, remember: false, host: "https://example.com" }],
    ["a token sent with connect_saved", { type: "connect_saved", token: validToken }],
    ["a send without a prompt", { type: "send", model: "gpt-5-mini" }],
    ["an empty prompt", { type: "send", model: "gpt-5-mini", prompt: "" }],
    ["a non-string prompt", { type: "send", model: "gpt-5-mini", prompt: ["hi"] }],
    ["an oversized prompt", { type: "send", model: "gpt-5-mini", prompt: "p".repeat(MAX_PROMPT_LENGTH + 1) }],
    ["tools smuggled into send", { type: "send", model: "gpt-5-mini", prompt: "hi", tools: ["shell"] }],
    ["an empty model", { type: "send", model: "", prompt: "hi" }],
    ["a non-string model", { type: "send", model: 5, prompt: "hi" }],
    ["an oversized model", { type: "send", model: "m".repeat(201), prompt: "hi" }],
    ["an extra stop field", { type: "stop", force: true }],
    ["an extra new_chat field", { type: "new_chat", model: "gpt-5-mini" }],
    ["an extra forget field", { type: "forget", account: "octocat" }],
  ])("rejects %s", (_description, value) => {
    expect(parsePanelMessage(value)).toBeUndefined();
  });
});

describe("companion to panel messages", () => {
  it.each([
    { type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion: "1.0.14", savedToken: false, runtime: "missing" },
    { type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion: "1.0.14", savedToken: true, runtime: "unsupported" },
    { type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion: "1.0.14", savedToken: true, runtime: "ready", runtimeVersion: "1.0.89-3" },
    { type: "connected", models: [] },
    {
      type: "connected",
      login: "octocat",
      models: [
        { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 },
        { id: "unbilled", name: "Unbilled" },
      ],
    },
    { type: "delta", text: "こんにちは <b>world</b>" },
    { type: "usage", model: "gpt-5-mini" },
    { type: "usage", model: "gpt-5-mini", cost: 0.33 },
    { type: "done", outcome: "complete" },
    { type: "done", outcome: "stopped" },
    { type: "credential", saved: true },
    { type: "credential", saved: false },
    { type: "error", stage: "connect", code: "auth_failed" },
    { type: "error", stage: "connect", code: "no_saved_token" },
    { type: "error", stage: "connect", code: "keychain_read_failed" },
    { type: "error", stage: "credential", code: "save_failed" },
    { type: "error", stage: "credential", code: "forget_failed" },
    { type: "error", stage: "send", code: "output_limit" },
    { type: "error", stage: "send", code: "context_limit" },
    { type: "error", stage: "protocol", code: "frame_too_large" },
  ])("accepts %j", (message) => {
    expect(parseCompanionMessage(message)).toEqual(message);
  });

  it.each([
    ["a non-integer protocol version", { type: "hello", protocolVersion: 1.5, sdkVersion: "1.0.14", savedToken: false, runtime: "ready" }],
    ["a missing SDK version", { type: "hello", protocolVersion: 2, savedToken: false, runtime: "ready" }],
    ["a hello without the saved-token flag", { type: "hello", protocolVersion: 1, sdkVersion: "1.0.14", runtime: "ready" }],
    ["a saved-token flag that is not a boolean", { type: "hello", protocolVersion: 2, sdkVersion: "1.0.14", savedToken: "yes", runtime: "ready" }],
    ["a hello without the runtime state", { type: "hello", protocolVersion: 4, sdkVersion: "1.0.14", savedToken: false }],
    ["an unknown runtime state", { type: "hello", protocolVersion: 4, sdkVersion: "1.0.14", savedToken: false, runtime: "broken" }],
    [
      "a runtime version that is not a string",
      { type: "hello", protocolVersion: 4, sdkVersion: "1.0.14", savedToken: false, runtime: "ready", runtimeVersion: 1 },
    ],
    ["non-array models", { type: "connected", models: "gpt-5-mini" }],
    ["a model without a name", { type: "connected", models: [{ id: "gpt-5-mini" }] }],
    ["a negative multiplier", { type: "connected", models: [{ id: "m", name: "M", multiplier: -1 }] }],
    ["an extra model field", { type: "connected", models: [{ id: "m", name: "M", policy: "enabled" }] }],
    ["too many models", { type: "connected", models: Array.from({ length: 201 }, (_, index) => ({ id: `m${index}`, name: "M" })) }],
    ["a non-string login", { type: "connected", login: 7, models: [] }],
    ["non-string delta text", { type: "delta", text: 42 }],
    ["delta text beyond the output cap", { type: "delta", text: "x".repeat(MAX_OUTPUT_LENGTH + 1) }],
    ["a negative cost", { type: "usage", model: "m", cost: -0.1 }],
    ["an unknown outcome", { type: "done", outcome: "partial" }],
    ["a credential message without the saved flag", { type: "credential" }],
    ["a credential message that carries the token", { type: "credential", saved: true, token: validToken }],
    ["a credential error code under another stage", { type: "error", stage: "connect", code: "save_failed" }],
    ["an unknown error stage", { type: "error", stage: "runtime", code: "timeout" }],
    ["an error code from another stage", { type: "error", stage: "protocol", code: "auth_failed" }],
    ["free-form error text", { type: "error", stage: "send", code: "send_failed", message: "401 Unauthorized: {...}" }],
  ])("rejects %s", (_description, value) => {
    expect(parseCompanionMessage(value)).toBeUndefined();
  });
});
