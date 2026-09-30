export const PROTOCOL_VERSION = 4;

export const MAX_TOKEN_LENGTH = 255;
export const MAX_FIELD_LENGTH = 200;
export const MAX_MODELS = 200;
export const MAX_PROMPT_LENGTH = 32_768;
export const MAX_OUTPUT_LENGTH = 65_536;
export const MAX_PAGE_URL_LENGTH = 4_096;
export const MAX_PAGE_TITLE_LENGTH = 1_000;
export const MAX_PAGE_TEXT_LENGTH = 100_000;
export const MAX_PAGE_SELECTION_LENGTH = 32_768;
export const CONNECT_TIMEOUT_MS = 60_000;
export const TURN_TIMEOUT_MS = 300_000;

export const ERROR_CODES_BY_STAGE = {
  connect: [
    "busy",
    "already_connected",
    "no_saved_token",
    "keychain_read_failed",
    "runtime_not_found",
    "runtime_unsupported",
    "sdk_start_failed",
    "auth_failed",
    "models_unavailable",
    "timeout",
  ],
  send: [
    "busy",
    "not_connected",
    "unknown_model",
    "auth_failed",
    "not_authorized",
    "quota_exceeded",
    "rate_limited",
    "context_limit",
    "send_failed",
    "output_limit",
    "timeout",
  ],
  credential: ["save_failed", "forget_failed"],
  protocol: ["invalid_message", "frame_too_large"],
} as const;

const TURN_OUTCOMES = ["complete", "stopped"] as const;

// What the companion found when it looked for the Copilot CLI it runs the SDK against. Reported in
// the handshake so the panel can explain a missing CLI before a PAT is ever pasted.
export const RUNTIME_STATES = ["ready", "missing", "unsupported"] as const;

type ErrorCodesByStage = typeof ERROR_CODES_BY_STAGE;
export type ErrorStage = keyof ErrorCodesByStage;
export type ErrorCode<Stage extends ErrorStage> = ErrorCodesByStage[Stage][number];
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export type PageContext = { url: string; title: string; text: string; selection?: string; truncated: boolean };

export type PanelMessage =
  | { type: "connect"; token: string; remember: boolean }
  | { type: "connect_saved" }
  | { type: "send"; model: string; prompt: string; page?: PageContext }
  | { type: "stop" }
  | { type: "new_chat" }
  | { type: "forget" };

export type ModelSummary = { id: string; name: string; multiplier?: number };

export type CompanionErrorMessage = {
  [Stage in ErrorStage]: { type: "error"; stage: Stage; code: ErrorCode<Stage> };
}[ErrorStage];

export type CompanionMessage =
  | { type: "hello"; protocolVersion: number; sdkVersion: string; savedToken: boolean; runtime: RuntimeState; runtimeVersion?: string }
  | { type: "connected"; login?: string; models: ModelSummary[] }
  | { type: "credential"; saved: boolean }
  | { type: "delta"; text: string }
  | { type: "usage"; model: string; cost?: number }
  | { type: "done"; outcome: TurnOutcome }
  | CompanionErrorMessage;

type JsonObject = Record<string, unknown>;

const FINE_GRAINED_TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]+$/;

export function isFineGrainedPersonalAccessToken(token: string) {
  return token.length <= MAX_TOKEN_LENGTH && FINE_GRAINED_TOKEN_PATTERN.test(token);
}

export function parsePanelMessage(value: unknown): PanelMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "connect":
      return hasExactlyKeys(value, ["type", "token", "remember"]) &&
        typeof value.token === "string" &&
        isFineGrainedPersonalAccessToken(value.token) &&
        typeof value.remember === "boolean"
        ? { type: "connect", token: value.token, remember: value.remember }
        : undefined;
    case "connect_saved":
      return hasExactlyKeys(value, ["type"]) ? { type: "connect_saved" } : undefined;
    case "send":
      return parseSend(value);
    case "stop":
      return hasExactlyKeys(value, ["type"]) ? { type: "stop" } : undefined;
    case "new_chat":
      return hasExactlyKeys(value, ["type"]) ? { type: "new_chat" } : undefined;
    case "forget":
      return hasExactlyKeys(value, ["type"]) ? { type: "forget" } : undefined;
    default:
      return undefined;
  }
}

export function parseCompanionMessage(value: unknown): CompanionMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "hello":
      return parseHello(value);
    case "connected":
      return parseConnected(value);
    case "credential":
      return hasExactlyKeys(value, ["type", "saved"]) && typeof value.saved === "boolean"
        ? { type: "credential", saved: value.saved }
        : undefined;
    case "delta":
      return hasExactlyKeys(value, ["type", "text"]) && isBoundedText(value.text, MAX_OUTPUT_LENGTH)
        ? { type: "delta", text: value.text }
        : undefined;
    case "usage":
      return parseUsage(value);
    case "done":
      return hasExactlyKeys(value, ["type", "outcome"]) && isOneOf(value.outcome, TURN_OUTCOMES)
        ? { type: "done", outcome: value.outcome }
        : undefined;
    case "error":
      return parseError(value);
    default:
      return undefined;
  }
}

function parseHello(value: JsonObject): CompanionMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "protocolVersion", "sdkVersion", "savedToken", "runtime"], ["runtimeVersion"])) return undefined;
  const { protocolVersion, sdkVersion, savedToken, runtime, runtimeVersion } = value;
  if (!isInteger(protocolVersion) || !isBoundedField(sdkVersion) || typeof savedToken !== "boolean") return undefined;
  if (!isOneOf(runtime, RUNTIME_STATES)) return undefined;
  const hello = { type: "hello", protocolVersion, sdkVersion, savedToken, runtime } as const;
  if (runtimeVersion === undefined) return hello;
  return isBoundedField(runtimeVersion) ? { ...hello, runtimeVersion } : undefined;
}

function parseSend(value: JsonObject): PanelMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "model", "prompt"], ["page"])) return undefined;
  if (!isBoundedField(value.model) || !isBoundedText(value.prompt, MAX_PROMPT_LENGTH)) return undefined;
  if (value.page === undefined) return { type: "send", model: value.model, prompt: value.prompt };
  const page = parsePageContext(value.page);
  return page ? { type: "send", model: value.model, prompt: value.prompt, page } : undefined;
}

export function parsePageContext(value: unknown): PageContext | undefined {
  if (!isJsonObject(value) || !hasExactlyKeys(value, ["url", "title", "text", "truncated"], ["selection"])) return undefined;
  const { url, title, text, selection, truncated } = value;
  if (!isBoundedText(url, MAX_PAGE_URL_LENGTH) || typeof truncated !== "boolean") return undefined;
  if (!isStringWithin(title, MAX_PAGE_TITLE_LENGTH) || !isStringWithin(text, MAX_PAGE_TEXT_LENGTH)) return undefined;
  if (selection === undefined) return { url, title, text, truncated };
  return isBoundedText(selection, MAX_PAGE_SELECTION_LENGTH) ? { url, title, text, selection, truncated } : undefined;
}

function parseConnected(value: JsonObject): CompanionMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "models"], ["login"])) return undefined;
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) return undefined;
  const models = value.models.map(parseModel);
  if (!models.every((model): model is ModelSummary => model !== undefined)) return undefined;
  if (value.login === undefined) return { type: "connected", models };
  return isBoundedField(value.login) ? { type: "connected", login: value.login, models } : undefined;
}

function parseModel(value: unknown): ModelSummary | undefined {
  if (!isJsonObject(value) || !hasExactlyKeys(value, ["id", "name"], ["multiplier"])) return undefined;
  if (!isBoundedField(value.id) || !isBoundedField(value.name)) return undefined;
  if (value.multiplier === undefined) return { id: value.id, name: value.name };
  return isNonNegativeNumber(value.multiplier) ? { id: value.id, name: value.name, multiplier: value.multiplier } : undefined;
}

function parseUsage(value: JsonObject): CompanionMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "model"], ["cost"]) || !isBoundedField(value.model)) {
    return undefined;
  }
  if (value.cost === undefined) return { type: "usage", model: value.model };
  return isNonNegativeNumber(value.cost) ? { type: "usage", model: value.model, cost: value.cost } : undefined;
}

function parseError(value: JsonObject): CompanionErrorMessage | undefined {
  if (!hasExactlyKeys(value, ["type", "stage", "code"])) return undefined;
  const { stage, code } = value;
  if (stage === "connect" && isOneOf(code, ERROR_CODES_BY_STAGE.connect)) return { type: "error", stage, code };
  if (stage === "send" && isOneOf(code, ERROR_CODES_BY_STAGE.send)) return { type: "error", stage, code };
  if (stage === "credential" && isOneOf(code, ERROR_CODES_BY_STAGE.credential)) return { type: "error", stage, code };
  if (stage === "protocol" && isOneOf(code, ERROR_CODES_BY_STAGE.protocol)) return { type: "error", stage, code };
  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

export function isBoundedField(value: unknown): value is string {
  return isBoundedText(value, MAX_FIELD_LENGTH);
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isStringWithin(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isOneOf<Option extends string>(value: unknown, options: readonly Option[]): value is Option {
  return options.some((option) => option === value);
}
