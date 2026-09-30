import type { BridgeFailure } from "./companion.ts";
import type { PageCaptureFailure } from "./page.ts";
import { PAGE_CAPTURE_TIMEOUT_MS } from "./page.ts";
import { HOST_NAME } from "../protocol/identity.ts";
import { CONNECT_TIMEOUT_MS, MAX_OUTPUT_LENGTH, MAX_PROMPT_LENGTH, MINIMUM_COPILOT_CLI_VERSION, TURN_TIMEOUT_MS } from "../protocol/messages.ts";
import type { ErrorCode, ModelSummary, RuntimeState } from "../protocol/messages.ts";

const REINSTALL_HINT = "install the Prompt Harbor companion package for this Mac, then choose Try again.";
const CONNECT_TIMEOUT_SECONDS = CONNECT_TIMEOUT_MS / 1000;
const TURN_TIMEOUT_MINUTES = TURN_TIMEOUT_MS / 60_000;
const OUTPUT_LIMIT = formatCount(MAX_OUTPUT_LENGTH);
const PROMPT_LIMIT = formatCount(MAX_PROMPT_LENGTH);

export const STATUS_TEXT = {
  starting: "Starting…",
  connecting: "Connecting to GitHub…",
} as const;

export const NO_MODELS_TEXT = "GitHub returned no enabled models for this account, so there is nothing to send.";

export const COPILOT_CLI_INSTALL_COMMAND = "brew install --cask copilot-cli";

const RUNTIME_MISSING_TEXT =
  "The companion could not find the GitHub Copilot CLI, which it needs to reach Copilot. Install it with " +
  `${COPILOT_CLI_INSTALL_COMMAND}, or see the GitHub Copilot CLI documentation, then choose Try again.`;

function runtimeUnsupportedText(version?: string) {
  const found = version === undefined ? "The GitHub Copilot CLI the companion found" : `GitHub Copilot CLI ${version}`;
  return (
    `${found} is older than ${MINIMUM_COPILOT_CLI_VERSION}, or is not the Copilot CLI at all. ` +
    "Update it with copilot update, then choose Try again."
  );
}

// The panel can explain a missing or unusable Copilot CLI straight from the handshake, before a
// PAT is ever pasted. "ready" needs no notice.
export function runtimeStatusText(runtime: RuntimeState, version?: string) {
  if (runtime === "missing") return RUNTIME_MISSING_TEXT;
  return runtime === "unsupported" ? runtimeUnsupportedText(version) : undefined;
}

export const MODEL_PLACEHOLDER_TEXT = {
  disconnected: "Model",
  none: "No models",
} as const;

export const PROMPT_AUTHOR_LABEL = "You";
export const STOPPED_TURN_NOTE = "Stopped. Output may be incomplete.";
export const INTERRUPTED_TURN_NOTE = "The companion stopped before the response finished.";

export const NOT_FINE_GRAINED_PAT = {
  code: "not_fine_grained_pat",
  text: "Only fine-grained PATs are accepted, and they start with github_pat_. The token was not sent.",
} as const;

export const PAGE_CAPTURE_ERROR_TEXT: Record<PageCaptureFailure, string> = {
  page_access_needed:
    "Chrome has not given Copilot access to this tab, so nothing was sent. Click the extension's toolbar icon " +
    "while this tab is showing, then send again. Access ends when the tab goes to another site. " +
    "For file:// pages, also turn on Allow access to file URLs for this extension in chrome://extensions.",
  page_restricted:
    "Chrome never lets extensions read this page, so nothing was sent. " +
    "This covers chrome:// pages, the New Tab page, the Chrome Web Store, other extensions and sites blocked by policy.",
  page_error_page: "This tab is showing an error page, so nothing was sent. Reload the page, then send again.",
  page_unreadable: "Copilot could not read this tab, so nothing was sent.",
  page_timeout: `The tab did not respond within ${PAGE_CAPTURE_TIMEOUT_MS / 1000} seconds, so nothing was sent.`,
};

export function pageCaptureErrorText(failure: PageCaptureFailure, detail?: string) {
  const text = PAGE_CAPTURE_ERROR_TEXT[failure];
  return detail === undefined ? text : `${text} Chrome said: ${detail}`;
}

export function includedPageLabel({ title, url }: { title: string; url: string }) {
  return `Included page: ${title === "" ? url : title}`;
}

export const BRIDGE_FAILURE_TEXT: Record<BridgeFailure, string> = {
  companion_not_installed: `The local companion is not installed. To install it, ${REINSTALL_HINT}`,
  companion_forbidden: `Chrome refused to start the companion for this extension. To repair it, ${REINSTALL_HINT}`,
  companion_start_failed: `Chrome could not start the companion. To repair it, ${REINSTALL_HINT}`,
  companion_exited: "The companion stopped unexpectedly, discarding its PAT and SDK session. Choose Try again to start a fresh one.",
  companion_protocol:
    "The companion sent a message this panel does not accept, so the panel disconnected it. " +
    "If you updated this checkout, run pnpm build and reload the extension in chrome://extensions. " +
    `Otherwise, ${REINSTALL_HINT}`,
};

export const CONNECT_ERROR_TEXT: Record<ErrorCode<"connect">, string> = {
  busy: "A connection attempt is already running.",
  already_connected: "The companion is already connected. Sign out to use a different PAT.",
  no_saved_token: "No PAT is saved in your macOS login keychain anymore. Paste a PAT to connect.",
  keychain_read_failed:
    "The companion could not read the saved PAT from your macOS login keychain. " +
    "Unlock the keychain and choose Try again, or choose Sign out and paste a new PAT.",
  runtime_not_found: RUNTIME_MISSING_TEXT,
  runtime_unsupported: runtimeUnsupportedText(),
  sdk_start_failed: "The GitHub Copilot CLI on this Mac could not be started, so nothing was sent.",
  auth_failed:
    "GitHub did not accept this PAT. Use an unexpired fine-grained PAT owned by your personal account with the Copilot Requests permission.",
  models_unavailable: "The PAT was accepted, but the Copilot SDK could not list models for this account.",
  timeout: `Connecting took longer than ${CONNECT_TIMEOUT_SECONDS} seconds, so the companion gave up.`,
};

export const SAVED_TOKEN_REJECTED_TEXT =
  "GitHub did not accept the saved PAT. It may have expired or been revoked. Paste a new PAT to replace it.";

export const CREDENTIAL_ERROR_TEXT: Record<ErrorCode<"credential">, string> = {
  save_failed:
    "You are still connected, but the companion could not save the PAT in your macOS login keychain, " +
    "so you will need to paste it next time.",
  forget_failed:
    "Sign out did not finish because the companion could not remove the saved PAT. " +
    `Delete the ${HOST_NAME} item in Keychain Access, then choose Sign out again.`,
};

export const SEND_ERROR_TEXT: Record<ErrorCode<"send">, string> = {
  busy: "A request is already running.",
  not_connected: "Connect with a PAT before sending.",
  unknown_model: "That model is not in the list returned for this account.",
  auth_failed: "GitHub rejected the PAT during the request.",
  not_authorized: "This account is not allowed to use that model.",
  quota_exceeded: "The Copilot allowance for this model is used up.",
  rate_limited: "GitHub is rate-limiting requests. Wait before trying again.",
  context_limit: "The conversation is too long for this model's context window. Choose New chat to start over.",
  send_failed: "The request failed before the response finished.",
  output_limit: `The response passed ${OUTPUT_LIMIT} characters, so the companion stopped it. Output is incomplete.`,
  timeout: `The response did not finish within ${TURN_TIMEOUT_MINUTES} minutes, so the companion stopped it. Output may be incomplete.`,
};

export function modelOptionLabel({ name, multiplier }: ModelSummary) {
  return multiplier === undefined ? name : `${name} (${multiplier}×)`;
}

export function replyAuthorLabel(modelName: string) {
  return `Copilot (${modelName})`;
}

export function failedTurnNote(code: ErrorCode<"send">) {
  return `The request did not finish (${code}).`;
}

export function promptTooLongText(length: number) {
  return `This prompt is ${formatCount(length)} characters. Shorten it to ${PROMPT_LIMIT} or fewer to send.`;
}

function formatCount(count: number) {
  return count.toLocaleString("en-US");
}
