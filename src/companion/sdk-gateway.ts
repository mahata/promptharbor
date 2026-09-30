import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopilotClient, CopilotSession, ModelInfo, SessionEvent } from "@github/copilot-sdk";
import { GatewayFailure } from "./gateway.ts";
import type { ConnectedAccount, CopilotGateway, GatewayFailureCode, TurnEvent, TurnFailureCode, TurnRequest } from "./gateway.ts";
import { SYSTEM_PATH } from "./system-path.ts";
import { MAX_MODELS, isBoundedField, isNonNegativeNumber } from "../protocol/messages.ts";
import type { ModelSummary, TurnOutcome } from "../protocol/messages.ts";

const APPLICATION_NAME = "prompt-harbor";
export const GRACEFUL_STOP_TIMEOUT_MS = 5_000;

const TURN_FAILURE_BY_ERROR_TYPE = new Map<string, TurnFailureCode>([
  ["authentication", "auth_failed"],
  ["authorization", "not_authorized"],
  ["quota", "quota_exceeded"],
  ["rate_limit", "rate_limited"],
  ["context_limit", "context_limit"],
]);

type Conversation = { session: CopilotSession; model: string };

export type SdkGatewayOptions = { runtimePath: string; cacheDirectory: string };

export function createSdkGateway({ runtimePath, cacheDirectory }: SdkGatewayOptions): CopilotGateway {
  let closed = false;
  let client: CopilotClient | undefined;
  let privateHome: string | undefined;
  let conversation: Conversation | undefined;

  function ensureOpen(failureCode: GatewayFailureCode) {
    if (closed) throw new GatewayFailure(failureCode);
  }

  async function conversationSessionFor(model: string) {
    const activeClient = client;
    const workingDirectory = privateHome;
    if (!activeClient || !workingDirectory || closed) throw new GatewayFailure("send_failed");

    const current = conversation;
    if (current) {
      if (current.model !== model) {
        await attempt(() => current.session.setModel(model), "send_failed");
        ensureOpen("send_failed");
        current.model = model;
      }
      return current.session;
    }

    const session = await attempt(
      () =>
        activeClient.createSession({
          model,
          streaming: true,
          availableTools: [],
          onPermissionRequest: () => ({ kind: "reject" }),
          infiniteSessions: { enabled: false },
          workingDirectory,
        }),
      "send_failed",
    );
    ensureOpen("send_failed");
    conversation = { session, model };
    return session;
  }

  return {
    async connect(token) {
      const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
      const home = await mkdtemp(join(tmpdir(), `${APPLICATION_NAME}-`));
      if (closed) {
        await removeDirectory(home);
        throw new GatewayFailure("sdk_start_failed");
      }
      privateHome = home;
      // HOME is the companion's cache directory so the Copilot CLI unpacks its runtime once and
      // reuses it, while its Copilot home, temporary directory and working directory stay this
      // throwaway one, keeping it away from the user's own ~/.copilot configuration.
      await mkdir(cacheDirectory, { recursive: true }).catch(() => undefined);
      const env = { HOME: cacheDirectory, TMPDIR: home, COPILOT_HOME: home, PATH: SYSTEM_PATH };
      const startingClient = new CopilotClient({
        mode: "empty",
        connection: RuntimeConnection.forStdio({ path: runtimePath, env }),
        baseDirectory: home,
        workingDirectory: home,
        gitHubToken: token,
        useLoggedInUser: false,
        logLevel: "error",
        clientInfo: { applicationName: APPLICATION_NAME },
      });
      client = startingClient;

      await attempt(() => startingClient.start(), "sdk_start_failed");
      ensureOpen("sdk_start_failed");
      const authStatus = await attempt(() => startingClient.getAuthStatus(), "auth_failed");
      ensureOpen("auth_failed");
      if (!authStatus.isAuthenticated) throw new GatewayFailure("auth_failed");
      const models = await attempt(() => startingClient.listModels(), "models_unavailable");
      ensureOpen("models_unavailable");
      return toConnectedAccount(authStatus.login, models);
    },

    startTurn({ model, prompt, onEvent }: TurnRequest) {
      let session: CopilotSession | undefined;
      let abortRequested = false;

      const outcome = (async (): Promise<TurnOutcome> => {
        session = await conversationSessionFor(model);
        if (abortRequested) return "stopped";
        return runTurn(session, prompt, onEvent);
      })();

      return {
        outcome,
        async abort() {
          abortRequested = true;
          await session?.abort();
        },
      };
    },

    startNewConversation() {
      const previous = conversation;
      conversation = undefined;
      void previous?.session.disconnect().catch(() => undefined);
    },

    async close() {
      closed = true;
      const closingClient = client;
      const closingHome = privateHome;
      client = undefined;
      privateHome = undefined;
      conversation = undefined;
      if (closingClient) await stopClient(closingClient);
      if (closingHome) await removeDirectory(closingHome);
    },
  };
}

function runTurn(session: CopilotSession, prompt: string, onEvent: (event: TurnEvent) => void) {
  return new Promise<TurnOutcome>((resolve, reject) => {
    let failure: GatewayFailure | undefined;
    const unsubscribe = session.on((event: SessionEvent) => {
      if ("agentId" in event && event.agentId !== undefined) return;
      switch (event.type) {
        case "assistant.message_delta":
          if (typeof event.data.deltaContent === "string") onEvent({ type: "delta", text: event.data.deltaContent });
          return;
        case "assistant.usage": {
          const usage = toUsageEvent(event.data.model, event.data.cost);
          if (usage) onEvent(usage);
          return;
        }
        case "session.error":
          failure ??= new GatewayFailure(TURN_FAILURE_BY_ERROR_TYPE.get(event.data.errorType) ?? "send_failed");
          return;
        case "session.idle":
          unsubscribe();
          if (failure) reject(failure);
          else resolve(event.data.aborted === true ? "stopped" : "complete");
          return;
      }
    });
    session.send({ prompt }).catch(() => {
      unsubscribe();
      reject(new GatewayFailure("send_failed"));
    });
  });
}

function toConnectedAccount(login: unknown, models: readonly ModelInfo[]): ConnectedAccount {
  const enabledModels = models
    .filter((model) => model.policy?.state === "enabled")
    .flatMap(toModelSummary)
    .slice(0, MAX_MODELS);
  return isBoundedField(login) ? { login, models: enabledModels } : { models: enabledModels };
}

function toModelSummary({ id, name, billing }: ModelInfo): ModelSummary[] {
  if (!isBoundedField(id) || !isBoundedField(name)) return [];
  const multiplier = billing?.multiplier;
  return [isNonNegativeNumber(multiplier) ? { id, name, multiplier } : { id, name }];
}

function toUsageEvent(model: unknown, cost: unknown): TurnEvent | undefined {
  if (!isBoundedField(model)) return undefined;
  return isNonNegativeNumber(cost) ? { type: "usage", model, cost } : { type: "usage", model };
}

async function attempt<Value>(operation: () => Promise<Value>, failureCode: GatewayFailureCode): Promise<Value> {
  try {
    return await operation();
  } catch {
    throw new GatewayFailure(failureCode);
  }
}

async function stopClient(client: CopilotClient) {
  const gracefulStop = client.stop().then(
    (cleanupErrors) => cleanupErrors.length === 0,
    () => false,
  );
  const stoppedCleanly = await withDeadline(gracefulStop, GRACEFUL_STOP_TIMEOUT_MS, false);
  if (!stoppedCleanly) await client.forceStop().catch(() => undefined);
}

function withDeadline<Value>(operation: Promise<Value>, timeoutMs: number, valueAfterTimeout: Value) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Value>((resolve) => {
    timer = setTimeout(() => resolve(valueAfterTimeout), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function removeDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
