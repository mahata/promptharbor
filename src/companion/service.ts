import { CONNECT_FAILURE_CODES, GatewayFailure, TURN_FAILURE_CODES } from "./gateway.ts";
import type { ConnectedAccount, ConnectFailureCode, CopilotGateway, Turn, TurnEvent, TurnFailureCode } from "./gateway.ts";
import type { CredentialStore } from "./keychain.ts";
import type { RuntimeStatus } from "./runtime.ts";
import { CONNECT_TIMEOUT_MS, MAX_OUTPUT_LENGTH, TURN_TIMEOUT_MS } from "../protocol/messages.ts";
import type { CompanionMessage, ErrorCode, PageContext, PanelMessage } from "../protocol/messages.ts";
import { composePrompt } from "./page-prompt.ts";

export const ABORT_TIMEOUT_MS = 5_000;

type CompanionServiceOptions = {
  createGateway: (runtimePath: string) => CopilotGateway;
  // What the companion found when it started. A usable Copilot CLI is taken at its word, so an
  // ordinary connection costs no extra lookup.
  runtime: RuntimeStatus;
  // Consulted again only when the startup lookup came up short, so installing the Copilot CLI and
  // connecting works without restarting the companion.
  resolveRuntime: () => Promise<RuntimeStatus>;
  store: CredentialStore;
  emit: (message: CompanionMessage) => void;
  onRuntimeStuck: () => void;
};

// The gateway arrives only once the Copilot CLI has been located, so a connection that is still
// resolving has none to close.
type Connecting = { phase: "connecting"; gateway?: CopilotGateway; saveTokenOnSuccess: boolean };
type Connected = { phase: "connected"; gateway: CopilotGateway; modelIds: ReadonlySet<string> };
type Sending = {
  phase: "sending";
  gateway: CopilotGateway;
  modelIds: ReadonlySet<string>;
  turn: Turn;
  outputLength: number;
  stopRequested: boolean;
};
type Stopping = { phase: "stopping"; gateway: CopilotGateway; modelIds: ReadonlySet<string> };
type Closing = { phase: "closing"; cleanup: Promise<void> };
type Closed = { phase: "closed"; cleanup: Promise<void> };
type ServiceState = { phase: "ready" } | Connecting | Connected | Sending | Stopping | Closing | Closed;
type AbandonReason = "output_limit" | "timeout";

export function createCompanionService({
  createGateway,
  runtime,
  resolveRuntime,
  store,
  emit,
  onRuntimeStuck,
}: CompanionServiceOptions) {
  let state: ServiceState = { phase: "ready" };
  let knownRuntime = runtime;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pendingCredentialTasks: Promise<unknown> = Promise.resolve();

  function startDeadline(timeoutMs: number, onExpired: () => void) {
    deadline = setTimeout(onExpired, timeoutMs);
  }

  function clearDeadline() {
    clearTimeout(deadline);
    deadline = undefined;
  }

  function connect(token: string, remember: boolean) {
    const connecting = startConnecting({ saveTokenOnSuccess: remember });
    if (connecting) openGateway(connecting, token);
  }

  function connectWithSavedToken() {
    const connecting = startConnecting({ saveTokenOnSuccess: false });
    if (!connecting) return;
    queueCredentialTask(() => store.loadToken()).then(
      (savedToken) => {
        if (state !== connecting) return;
        if (savedToken === undefined) failConnect(connecting, "no_saved_token");
        else openGateway(connecting, savedToken);
      },
      () => failConnect(connecting, "keychain_read_failed"),
    );
  }

  function startConnecting({ saveTokenOnSuccess }: { saveTokenOnSuccess: boolean }) {
    if (state.phase === "connecting" || state.phase === "closing") {
      emit(connectError("busy"));
      return undefined;
    }
    if (state.phase !== "ready") {
      emit(connectError("already_connected"));
      return undefined;
    }

    const connecting: Connecting = { phase: "connecting", saveTokenOnSuccess };
    state = connecting;
    startDeadline(CONNECT_TIMEOUT_MS, () => failConnect(connecting, "timeout"));
    return connecting;
  }

  function openGateway(connecting: Connecting, token: string) {
    if (knownRuntime.state === "ready") return startGateway(connecting, knownRuntime.path, token);
    void resolveRuntime().then(
      (found) => {
        // A lookup that outlasted its connection is stale: a newer attempt may already have looked
        // again and found something else. Recording it would let the next connection start a path
        // that no longer exists, so an abandoned lookup is dropped and the next one looks afresh.
        if (state !== connecting) return;
        knownRuntime = found;
        if (found.state === "ready") startGateway(connecting, found.path, token);
        else failConnect(connecting, found.state === "missing" ? "runtime_not_found" : "runtime_unsupported");
      },
      () => failConnect(connecting, "runtime_not_found"),
    );
  }

  function startGateway(connecting: Connecting, runtimePath: string, token: string) {
    let gateway: CopilotGateway;
    try {
      gateway = createGateway(runtimePath);
    } catch {
      return failConnect(connecting, "sdk_start_failed");
    }
    connecting.gateway = gateway;
    connectGateway(connecting, gateway, token);
  }

  function connectGateway(connecting: Connecting, gateway: CopilotGateway, token: string) {
    let connected: Promise<ConnectedAccount>;
    try {
      connected = gateway.connect(token);
    } catch (error) {
      return failConnect(connecting, connectFailureCode(error));
    }
    connected.then(
      ({ login, models }) => {
        if (state !== connecting) return;
        clearDeadline();
        state = { phase: "connected", gateway, modelIds: new Set(models.map((model) => model.id)) };
        emit(login === undefined ? { type: "connected", models } : { type: "connected", login, models });
        if (connecting.saveTokenOnSuccess) saveToken(token);
      },
      (error: unknown) => failConnect(connecting, connectFailureCode(error)),
    );
  }

  function saveToken(token: string) {
    queueCredentialTask(() => store.saveToken(token)).then(
      () => emitUnlessClosed({ type: "credential", saved: true }),
      () => emitUnlessClosed(credentialError("save_failed")),
    );
  }

  function forgetToken() {
    if (state.phase === "connecting") state.saveTokenOnSuccess = false;
    queueCredentialTask(() => store.forgetToken()).then(
      () => emitUnlessClosed({ type: "credential", saved: false }),
      () => emitUnlessClosed(credentialError("forget_failed")),
    );
  }

  function queueCredentialTask<Result>(task: () => Promise<Result>) {
    const result = pendingCredentialTasks.then(task);
    pendingCredentialTasks = result.catch(() => undefined);
    return result;
  }

  function emitUnlessClosed(message: CompanionMessage) {
    if (state.phase !== "closed") emit(message);
  }

  function failConnect(connecting: Connecting, code: ErrorCode<"connect">) {
    if (state !== connecting) return;
    clearDeadline();
    const { gateway } = connecting;
    if (gateway === undefined) {
      state = { phase: "ready" };
      return emit(connectError(code));
    }
    const closing: Closing = { phase: "closing", cleanup: closeQuietly(gateway) };
    state = closing;
    void closing.cleanup.then(() => {
      if (state !== closing) return;
      state = { phase: "ready" };
      emit(connectError(code));
    });
  }

  function send(model: string, prompt: string, page?: PageContext) {
    if (state.phase === "ready") return emit(sendError("not_connected"));
    if (state.phase !== "connected") return emit(sendError("busy"));
    if (!state.modelIds.has(model)) return emit(sendError("unknown_model"));

    const { gateway, modelIds } = state;
    let sending: Sending;
    try {
      const turn = gateway.startTurn({
        model,
        prompt: composePrompt(prompt, page),
        onEvent: (event) => forwardTurnEvent(sending, event),
      });
      sending = { phase: "sending", gateway, modelIds, turn, outputLength: 0, stopRequested: false };
    } catch (error) {
      return emit(sendError(turnFailureCode(error)));
    }
    state = sending;
    startDeadline(TURN_TIMEOUT_MS, () => abandonTurn(sending, "timeout"));

    sending.turn.outcome.then(
      (outcome) => endTurn(sending, { type: "done", outcome }),
      (error: unknown) => endTurn(sending, sendError(turnFailureCode(error))),
    );
  }

  function forwardTurnEvent(sending: Sending, event: TurnEvent) {
    if (state !== sending) return;
    if (event.type === "usage") {
      const { model, cost } = event;
      return emit(cost === undefined ? { type: "usage", model } : { type: "usage", model, cost });
    }
    if (event.text.length === 0) return;

    const remainingLength = MAX_OUTPUT_LENGTH - sending.outputLength;
    if (event.text.length <= remainingLength) {
      sending.outputLength += event.text.length;
      return emit({ type: "delta", text: event.text });
    }
    const textWithinLimit = truncateWithoutSplittingSurrogatePairs(event.text, remainingLength);
    if (textWithinLimit.length > 0) emit({ type: "delta", text: textWithinLimit });
    abandonTurn(sending, "output_limit");
  }

  function abandonTurn(sending: Sending, reason: AbandonReason) {
    if (state !== sending) return;
    clearDeadline();
    const stopping: Stopping = { phase: "stopping", gateway: sending.gateway, modelIds: sending.modelIds };
    state = stopping;
    abortQuietly(sending.turn);
    startDeadline(ABORT_TIMEOUT_MS, () => giveUpOnRuntime(stopping, sendError(reason)));

    const reportOnceTurnEnds = () => {
      if (state !== stopping) return;
      clearDeadline();
      state = { phase: "connected", gateway: stopping.gateway, modelIds: stopping.modelIds };
      emit(sendError(reason));
    };
    sending.turn.outcome.then(reportOnceTurnEnds, reportOnceTurnEnds);
  }

  function giveUpOnRuntime(stuck: Sending | Stopping, message: CompanionMessage) {
    if (state !== stuck) return;
    emit(message);
    void shutdown();
    onRuntimeStuck();
  }

  function endTurn(sending: Sending, message: CompanionMessage) {
    if (state !== sending) return;
    clearDeadline();
    state = { phase: "connected", gateway: sending.gateway, modelIds: sending.modelIds };
    emit(message);
  }

  function stop() {
    if (state.phase !== "sending" || state.stopRequested) return;
    const sending = state;
    sending.stopRequested = true;
    clearDeadline();
    abortQuietly(sending.turn);
    startDeadline(ABORT_TIMEOUT_MS, () => giveUpOnRuntime(sending, { type: "done", outcome: "stopped" }));
  }

  function startNewChat() {
    if (state.phase === "ready") return emit(sendError("not_connected"));
    if (state.phase !== "connected") return emit(sendError("busy"));
    state.gateway.startNewConversation();
  }

  function shutdown() {
    if (state.phase !== "closed") {
      clearDeadline();
      const cleanup = Promise.all([cleanupFor(state), pendingCredentialTasks]).then(() => undefined);
      state = { phase: "closed", cleanup };
    }
    return state.cleanup;
  }

  return {
    handle(message: PanelMessage) {
      if (state.phase === "closed") return;
      switch (message.type) {
        case "connect":
          return connect(message.token, message.remember);
        case "connect_saved":
          return connectWithSavedToken();
        case "send":
          return send(message.model, message.prompt, message.page);
        case "stop":
          return stop();
        case "new_chat":
          return startNewChat();
        case "forget":
          return forgetToken();
      }
    },
    shutdown,
  };
}

function cleanupFor(state: Exclude<ServiceState, Closed>): Promise<void> {
  if (state.phase === "ready") return Promise.resolve();
  if (state.phase === "closing") return state.cleanup;
  if (state.gateway === undefined) return Promise.resolve();
  return closeQuietly(state.gateway);
}

function abortQuietly(turn: Turn) {
  turn.abort().catch(() => {});
}

function connectError(code: ErrorCode<"connect">): CompanionMessage {
  return { type: "error", stage: "connect", code };
}

function sendError(code: ErrorCode<"send">): CompanionMessage {
  return { type: "error", stage: "send", code };
}

function credentialError(code: ErrorCode<"credential">): CompanionMessage {
  return { type: "error", stage: "credential", code };
}

function connectFailureCode(error: unknown): ConnectFailureCode {
  const code = error instanceof GatewayFailure ? error.code : undefined;
  return CONNECT_FAILURE_CODES.find((candidate) => candidate === code) ?? "sdk_start_failed";
}

function turnFailureCode(error: unknown): TurnFailureCode {
  const code = error instanceof GatewayFailure ? error.code : undefined;
  return TURN_FAILURE_CODES.find((candidate) => candidate === code) ?? "send_failed";
}

function truncateWithoutSplittingSurrogatePairs(text: string, maxLength: number) {
  const truncated = text.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

async function closeQuietly(gateway: CopilotGateway) {
  try {
    await gateway.close();
  } catch {
    return;
  }
}
