import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { ConnectedAccount, CopilotGateway, TurnEvent, TurnRequest } from "../../src/companion/gateway.ts";
import type { CredentialStore } from "../../src/companion/keychain.ts";
import { ABORT_TIMEOUT_MS, createCompanionService } from "../../src/companion/service.ts";
import { CONNECT_TIMEOUT_MS, MAX_OUTPUT_LENGTH, TURN_TIMEOUT_MS } from "../../src/protocol/messages.ts";
import type { CompanionMessage, TurnOutcome } from "../../src/protocol/messages.ts";

const token = `github_pat_${"Z".repeat(82)}`;
const savedToken = `github_pat_${"S".repeat(82)}`;
const prompt = "Explain closures in JavaScript.";
const account: ConnectedAccount = {
  login: "octocat",
  models: [
    { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 },
  ],
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const READY_RUNTIME = { state: "ready", path: "/opt/homebrew/bin/copilot", version: "1.0.89-3" } as const;

function itemAt<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}`);
  return item;
}

function createFakeGateway() {
  const connection = deferred<ConnectedAccount>();
  const turns: {
    request: TurnRequest;
    outcome: ReturnType<typeof deferred<TurnOutcome>>;
    abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }[] = [];
  const gateway = {
    connect: vi.fn((_token: string) => connection.promise),
    startTurn: vi.fn((request: TurnRequest) => {
      const turn = { request, outcome: deferred<TurnOutcome>(), abort: vi.fn(async () => {}) };
      turns.push(turn);
      return { outcome: turn.outcome.promise, abort: turn.abort };
    }),
    startNewConversation: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies CopilotGateway;
  return { gateway, connection, turns };
}

type FakeGateway = ReturnType<typeof createFakeGateway>;

function createFakeStore(initialToken?: string) {
  let storedToken = initialToken;
  return {
    hasSavedToken: vi.fn(async () => storedToken !== undefined),
    loadToken: vi.fn(async () => storedToken),
    saveToken: vi.fn(async (tokenToSave: string) => {
      storedToken = tokenToSave;
    }),
    forgetToken: vi.fn(async () => {
      const removed = storedToken !== undefined;
      storedToken = undefined;
      return removed;
    }),
  } satisfies CredentialStore;
}

function startService({ store = createFakeStore() } = {}) {
  const gateways: FakeGateway[] = [];
  const emitted: CompanionMessage[] = [];
  const onRuntimeStuck = vi.fn();
  const service = createCompanionService({
    createGateway: () => {
      const fake = createFakeGateway();
      gateways.push(fake);
      return fake.gateway;
    },
    runtime: READY_RUNTIME,
    resolveRuntime: async () => READY_RUNTIME,
    store,
    emit: (message) => emitted.push(message),
    onRuntimeStuck,
  });
  return { service, gateways, emitted, onRuntimeStuck, store };
}

async function startConnected(options: Parameters<typeof startService>[0] = {}) {
  const started = startService(options);
  started.service.handle({ type: "connect", token, remember: false });
  itemAt(started.gateways, 0).connection.resolve(account);
  await settle();
  started.emitted.length = 0;
  return { ...started, gateway: itemAt(started.gateways, 0) };
}

function settle() {
  return vi.advanceTimersByTimeAsync(0);
}

function emitEvent(turn: { request: TurnRequest }, event: TurnEvent) {
  turn.request.onEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connect", () => {
  it("connects with the panel's token and reports the account and enabled models", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    expect(itemAt(gateways, 0).gateway.connect).toHaveBeenCalledWith(token);
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([{ type: "connected", login: "octocat", models: account.models }]);
  });

  it("omits the login when the gateway does not know it", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    itemAt(gateways, 0).connection.resolve({ models: [] });
    await settle();
    expect(emitted).toEqual([{ type: "connected", models: [] }]);
  });

  it("reports a coded failure, closes that gateway, and allows a fresh attempt", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    itemAt(gateways, 0).connection.reject(new GatewayFailure("auth_failed"));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "auth_failed" }]);
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();

    service.handle({ type: "connect", token, remember: false });
    expect(gateways).toHaveLength(2);
  });

  it("maps unexpected failures to a code without echoing their text", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    itemAt(gateways, 0).connection.reject(new Error(`401 Unauthorized for ${token}`));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "sdk_start_failed" }]);
    expect(JSON.stringify(emitted)).not.toContain(token);
  });

  it("reports a gateway that cannot be created as an SDK start failure", () => {
    const emitted: CompanionMessage[] = [];
    const service = createCompanionService({
      createGateway: () => {
        throw new Error("mkdtemp failed");
      },
      runtime: READY_RUNTIME,
      resolveRuntime: async () => READY_RUNTIME,
      store: createFakeStore(),
      emit: (message) => emitted.push(message),
      onRuntimeStuck: () => {},
    });
    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "sdk_start_failed" }]);
  });

  it("rejects a second connect while the first is running", () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "busy" }]);
    expect(gateways).toHaveLength(1);
  });

  it("keeps one token per companion once connected", async () => {
    const { service, gateways, emitted } = await startConnected();
    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "already_connected" }]);
    expect(gateways).toHaveLength(1);
  });

  it("times out, closes the gateway, and ignores a late success", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "timeout" }]);
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();

    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toHaveLength(1);
  });

  it.each([
    ["fails", (fake: FakeGateway) => fake.connection.reject(new GatewayFailure("auth_failed")), "auth_failed"],
    ["times out", () => vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS), "timeout"],
  ] as const)("reports a connection that %s only after its gateway has closed, refusing a retry meanwhile", async (_description, endConnection, code) => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    const fake = itemAt(gateways, 0);
    const closing = deferred<void>();
    fake.gateway.close.mockImplementationOnce(() => closing.promise);
    await endConnection(fake);
    await settle();
    expect(fake.gateway.close).toHaveBeenCalledOnce();

    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "busy" }]);
    expect(gateways).toHaveLength(1);

    closing.resolve();
    await settle();
    expect(emitted).toEqual([
      { type: "error", stage: "connect", code: "busy" },
      { type: "error", stage: "connect", code },
    ]);
    service.handle({ type: "connect", token, remember: false });
    expect(gateways).toHaveLength(2);
  });
});

describe("saved PAT", () => {
  it("saves a PAT only after GitHub accepts it, then confirms the save", async () => {
    const { service, gateways, emitted, store } = startService();
    service.handle({ type: "connect", token, remember: true });
    await settle();
    expect(store.saveToken).not.toHaveBeenCalled();

    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(store.saveToken).toHaveBeenCalledExactlyOnceWith(token);
    expect(emitted).toEqual([
      { type: "connected", login: "octocat", models: account.models },
      { type: "credential", saved: true },
    ]);
  });

  it("does not save a PAT it was not asked to remember", async () => {
    const { store, emitted } = await startConnected();
    expect(store.saveToken).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("never saves a PAT that GitHub rejected", async () => {
    const { service, gateways, emitted, store } = startService();
    service.handle({ type: "connect", token, remember: true });
    itemAt(gateways, 0).connection.reject(new GatewayFailure("auth_failed"));
    await settle();
    expect(store.saveToken).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "auth_failed" }]);
  });

  it("reports a failed save and stays connected", async () => {
    const store = createFakeStore();
    store.saveToken.mockRejectedValueOnce(new Error(`security failed for ${token}`));
    const { service, gateways, emitted } = startService({ store });
    service.handle({ type: "connect", token, remember: true });
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([
      { type: "connected", login: "octocat", models: account.models },
      { type: "error", stage: "credential", code: "save_failed" },
    ]);
    expect(JSON.stringify(emitted)).not.toContain(token);

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(itemAt(gateways, 0).turns).toHaveLength(1);
  });

  it("connects with the saved PAT without saving it again", async () => {
    const { service, gateways, emitted, store } = startService({ store: createFakeStore(savedToken) });
    service.handle({ type: "connect_saved" });
    await settle();
    expect(store.loadToken).toHaveBeenCalledOnce();
    expect(itemAt(gateways, 0).gateway.connect).toHaveBeenCalledExactlyOnceWith(savedToken);

    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([{ type: "connected", login: "octocat", models: account.models }]);
    expect(store.saveToken).not.toHaveBeenCalled();
  });

  it.each([
    ["no PAT is saved", (store: ReturnType<typeof createFakeStore>) => store, "no_saved_token"],
    [
      "the saved PAT cannot be read",
      (store: ReturnType<typeof createFakeStore>) => {
        store.loadToken.mockRejectedValueOnce(new Error("security exited with 51"));
        return store;
      },
      "keychain_read_failed",
    ],
  ] as const)("reports when %s without starting the SDK, and allows another attempt", async (_description, prepare, code) => {
    const { service, gateways, emitted } = startService({ store: prepare(createFakeStore()) });
    service.handle({ type: "connect_saved" });
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "connect", code }]);
    // The Copilot CLI is never started for a PAT that could not be read.
    expect(gateways).toHaveLength(0);

    service.handle({ type: "connect", token, remember: false });
    expect(gateways).toHaveLength(1);
  });

  it("counts reading the saved PAT toward the connect deadline", async () => {
    const store = createFakeStore(savedToken);
    const reading = deferred<string | undefined>();
    store.loadToken.mockImplementationOnce(() => reading.promise);
    const { service, gateways, emitted } = startService({ store });
    service.handle({ type: "connect_saved" });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(emitted).toEqual([{ type: "error", stage: "connect", code: "timeout" }]);

    reading.resolve(savedToken);
    await settle();
    expect(gateways).toHaveLength(0);
    expect(emitted).toHaveLength(1);
  });

  it("refuses to connect with the saved PAT while connecting or connected", async () => {
    const { service, gateways, emitted } = startService({ store: createFakeStore(savedToken) });
    service.handle({ type: "connect_saved" });
    service.handle({ type: "connect_saved" });
    await settle();
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    service.handle({ type: "connect_saved" });
    expect(emitted).toEqual([
      { type: "error", stage: "connect", code: "busy" },
      { type: "connected", login: "octocat", models: account.models },
      { type: "error", stage: "connect", code: "already_connected" },
    ]);
    expect(gateways).toHaveLength(1);
  });

  it("forgets the saved PAT whether or not the companion is connected", async () => {
    const store = createFakeStore(savedToken);
    const { service, emitted } = startService({ store });
    service.handle({ type: "forget" });
    await settle();
    expect(store.forgetToken).toHaveBeenCalledOnce();
    expect(emitted).toEqual([{ type: "credential", saved: false }]);

    const connected = await startConnected({ store: createFakeStore(savedToken) });
    connected.service.handle({ type: "forget" });
    await settle();
    expect(connected.store.forgetToken).toHaveBeenCalledOnce();
    expect(connected.emitted).toEqual([{ type: "credential", saved: false }]);
  });

  it("does not save a remembered PAT that was forgotten while it was connecting", async () => {
    const store = createFakeStore(savedToken);
    const { service, gateways, emitted } = startService({ store });
    service.handle({ type: "connect", token, remember: true });
    service.handle({ type: "forget" });
    await settle();
    itemAt(gateways, 0).connection.resolve(account);
    await settle();

    expect(store.forgetToken).toHaveBeenCalledOnce();
    expect(store.saveToken).not.toHaveBeenCalled();
    await expect(store.hasSavedToken()).resolves.toBe(false);
    expect(emitted).toEqual([
      { type: "credential", saved: false },
      { type: "connected", login: "octocat", models: account.models },
    ]);
  });

  it("reports a PAT that could not be forgotten", async () => {
    const store = createFakeStore(savedToken);
    store.forgetToken.mockRejectedValueOnce(new Error("security exited with 51"));
    const { service, emitted } = startService({ store });
    service.handle({ type: "forget" });
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "credential", code: "forget_failed" }]);
  });

  it("runs Keychain operations one at a time, in the order they were asked for", async () => {
    const store = createFakeStore();
    const saving = deferred<void>();
    store.saveToken.mockImplementationOnce(() => saving.promise);
    const { service, gateways, emitted } = startService({ store });
    service.handle({ type: "connect", token, remember: true });
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    service.handle({ type: "forget" });
    await settle();
    expect(store.forgetToken).not.toHaveBeenCalled();

    saving.resolve();
    await settle();
    expect(store.forgetToken).toHaveBeenCalledOnce();
    expect(emitted).toEqual([
      { type: "connected", login: "octocat", models: account.models },
      { type: "credential", saved: true },
      { type: "credential", saved: false },
    ]);
  });
});

describe("send", () => {
  it("requires a connection first", () => {
    const { service, emitted } = startService();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "not_connected" }]);
  });

  it("only accepts a model offered by this connection", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "o1-preview", prompt });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "unknown_model" }]);
    expect(gateway.gateway.startTurn).not.toHaveBeenCalled();
  });

  it("sends the panel's prompt exactly as typed and streams deltas and usage until done", async () => {
    const { service, gateway, emitted } = await startConnected();
    const typedPrompt = "  Keep my indentation:\n\tconst answer = 42;\n";
    service.handle({ type: "send", model: "gpt-5-mini", prompt: typedPrompt });
    const turn = itemAt(gateway.turns, 0);
    expect(turn.request.model).toBe("gpt-5-mini");
    expect(turn.request.prompt).toBe(typedPrompt);

    emitEvent(turn, { type: "delta", text: "Connection " });
    emitEvent(turn, { type: "delta", text: "" });
    emitEvent(turn, { type: "delta", text: "confirmed." });
    emitEvent(turn, { type: "usage", model: "gpt-5-mini", cost: 0 });
    turn.outcome.resolve("complete");
    await settle();

    expect(emitted).toEqual([
      { type: "delta", text: "Connection " },
      { type: "delta", text: "confirmed." },
      { type: "usage", model: "gpt-5-mini", cost: 0 },
      { type: "done", outcome: "complete" },
    ]);
  });

  it("puts an attached page ahead of the typed prompt", async () => {
    const { service, gateway } = await startConnected();
    const page = { url: "https://example.com/", title: "Example", text: "Body text", truncated: false };
    service.handle({ type: "send", model: "gpt-5-mini", prompt, page });
    const sent = itemAt(gateway.turns, 0).request.prompt;
    expect(sent).toContain("URL: https://example.com/\nTitle: Example");
    expect(sent).toContain("Body text");
    expect(sent.endsWith(`User's message:\n${prompt}`)).toBe(true);
  });

  it("accepts another send after a turn finishes", async () => {
    const { service, gateway } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    service.handle({ type: "send", model: "claude-sonnet-4.5", prompt });
    expect(gateway.turns).toHaveLength(2);
  });

  it("runs one turn at a time", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "busy" },
      { type: "error", stage: "connect", code: "already_connected" },
    ]);
    expect(gateway.turns).toHaveLength(1);
  });

  it("maps coded and unexpected turn failures without echoing their text", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.reject(new GatewayFailure("rate_limited"));
    await settle();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 1).outcome.reject(new Error(`request failed with ${token}`));
    await settle();

    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "rate_limited" },
      { type: "error", stage: "send", code: "send_failed" },
    ]);
    expect(JSON.stringify(emitted)).not.toContain(token);
  });

  it("ignores a connect-only failure code from a turn", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.reject(new GatewayFailure("models_unavailable"));
    await settle();
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "send_failed" }]);
  });

  it("reports a conversation that outgrew the model's context window and stays connected", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.reject(new GatewayFailure("context_limit"));
    await settle();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });

    expect(emitted).toEqual([{ type: "error", stage: "send", code: "context_limit" }]);
    expect(gateway.turns).toHaveLength(2);
  });

  it("reports a turn that cannot start and stays connected", async () => {
    const { service, gateway, emitted } = await startConnected();
    gateway.gateway.startTurn.mockImplementationOnce(() => {
      throw new GatewayFailure("not_authorized");
    });
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "not_authorized" }]);
    expect(gateway.turns).toHaveLength(1);
  });
});

describe("stop", () => {
  it("aborts the active turn and reports the stopped outcome", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "Connec" });
    service.handle({ type: "stop" });
    expect(itemAt(gateway.turns, 0).abort).toHaveBeenCalledOnce();

    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    await settle();
    expect(emitted).toEqual([
      { type: "delta", text: "Connec" },
      { type: "done", outcome: "stopped" },
    ]);
  });

  it("does nothing without an active turn", async () => {
    const { service, emitted } = await startConnected();
    service.handle({ type: "stop" });
    expect(emitted).toEqual([]);
  });

  it("replaces the reply deadline with the abort deadline, then gives up on a runtime that has not ended the turn", async () => {
    const { service, gateway, emitted, onRuntimeStuck } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "stop" });
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS - 1);
    expect(emitted).toEqual([]);
    expect(onRuntimeStuck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([{ type: "done", outcome: "stopped" }]);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
    expect(onRuntimeStuck).toHaveBeenCalledOnce();

    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    await service.shutdown();
    expect(emitted).toHaveLength(1);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
  });

  it("keeps the first abort deadline and aborts only once when Stop is repeated", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "stop" });
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS - 1);
    service.handle({ type: "stop" });
    expect(itemAt(gateway.turns, 0).abort).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([{ type: "done", outcome: "stopped" }]);
  });
});

describe("new chat", () => {
  it("starts a new conversation without reporting anything", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    emitted.length = 0;

    service.handle({ type: "new_chat" });
    expect(gateway.gateway.startNewConversation).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(gateway.turns).toHaveLength(2);
  });

  it("requires a connection first", () => {
    const { service, emitted } = startService();
    service.handle({ type: "new_chat" });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "not_connected" }]);
  });

  it("refuses while connecting, while a turn runs, and while an abandoned turn ends", async () => {
    const connecting = startService();
    connecting.service.handle({ type: "connect", token, remember: false });
    connecting.service.handle({ type: "new_chat" });
    expect(connecting.emitted).toEqual([{ type: "error", stage: "send", code: "busy" }]);
    expect(itemAt(connecting.gateways, 0).gateway.startNewConversation).not.toHaveBeenCalled();

    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "new_chat" });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH + 1) });
    service.handle({ type: "new_chat" });
    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "busy" },
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH) },
      { type: "error", stage: "send", code: "busy" },
    ]);
    expect(gateway.gateway.startNewConversation).not.toHaveBeenCalled();
  });
});

describe("limits", () => {
  it("keeps partial output up to the cap, then aborts with output_limit", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    const turn = itemAt(gateway.turns, 0);
    emitEvent(turn, { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 3) });
    emitEvent(turn, { type: "delta", text: "bcdef" });
    emitEvent(turn, { type: "delta", text: "ignored" });
    turn.outcome.resolve("stopped");
    await settle();

    expect(emitted).toEqual([
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 3) },
      { type: "delta", text: "bcd" },
      { type: "error", stage: "send", code: "output_limit" },
    ]);
    expect(turn.abort).toHaveBeenCalledOnce();
  });

  it("never splits a surrogate pair at the output cap", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 1) });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "😀" });
    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    await settle();
    expect(emitted).toEqual([
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH - 1) },
      { type: "error", stage: "send", code: "output_limit" },
    ]);
  });

  it("reports the output limit only after the aborted turn ends, refusing sends meanwhile", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    const turn = itemAt(gateway.turns, 0);
    emitEvent(turn, { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH + 1) });
    expect(turn.abort).toHaveBeenCalledOnce();

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "connect", token, remember: false });
    expect(emitted).toEqual([
      { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH) },
      { type: "error", stage: "send", code: "busy" },
      { type: "error", stage: "connect", code: "already_connected" },
    ]);
    expect(gateway.turns).toHaveLength(1);

    turn.outcome.resolve("stopped");
    await settle();
    expect(emitted.at(-1)).toEqual({ type: "error", stage: "send", code: "output_limit" });
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(gateway.turns).toHaveLength(2);
  });

  it("times out a turn, aborts it, and reports the timeout once the turn ends, ignoring its late output", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    const turn = itemAt(gateway.turns, 0);
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS - 1);
    expect(turn.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(turn.abort).toHaveBeenCalledOnce();

    emitEvent(turn, { type: "delta", text: "late" });
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "busy" }]);

    turn.outcome.reject(new GatewayFailure("send_failed"));
    await settle();
    expect(emitted).toEqual([
      { type: "error", stage: "send", code: "busy" },
      { type: "error", stage: "send", code: "timeout" },
    ]);
    expect(gateway.turns).toHaveLength(1);
  });

  it("gives up on a runtime that has not ended an aborted turn in time", async () => {
    const { service, gateway, emitted, onRuntimeStuck } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + ABORT_TIMEOUT_MS - 1);
    expect(emitted).toEqual([]);
    expect(onRuntimeStuck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([{ type: "error", stage: "send", code: "timeout" }]);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
    expect(onRuntimeStuck).toHaveBeenCalledOnce();

    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    service.handle({ type: "connect", token, remember: false });
    await service.shutdown();
    expect(emitted).toHaveLength(1);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
  });

  it("clears the operation timer when a turn finishes in time", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    await settle();
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS * 2);
    expect(emitted).toEqual([{ type: "done", outcome: "complete" }]);
  });
});

describe("shutdown", () => {
  it("finishes a pending Keychain operation before shutting down, without reporting it", async () => {
    const store = createFakeStore();
    const saving = deferred<void>();
    store.saveToken.mockImplementationOnce(() => saving.promise);
    const { service, gateways, emitted } = startService({ store });
    service.handle({ type: "connect", token, remember: true });
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    service.handle({ type: "forget" });
    emitted.length = 0;

    let shutDown = false;
    void service.shutdown().then(() => (shutDown = true));
    await settle();
    expect(shutDown).toBe(false);

    saving.resolve();
    await settle();
    expect(shutDown).toBe(true);
    expect(store.forgetToken).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });

  it("closes the gateway, then ignores later messages and callbacks", async () => {
    const { service, gateway, emitted } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    await service.shutdown();
    expect(gateway.gateway.close).toHaveBeenCalledOnce();

    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "late" });
    itemAt(gateway.turns, 0).outcome.resolve("complete");
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    await service.shutdown();
    expect(emitted).toEqual([]);
    expect(gateway.gateway.close).toHaveBeenCalledOnce();
  });

  it("closes a gateway that is still connecting", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    await service.shutdown();
    expect(itemAt(gateways, 0).gateway.close).toHaveBeenCalledOnce();
    itemAt(gateways, 0).connection.resolve(account);
    await settle();
    expect(emitted).toEqual([]);
  });

  it("survives a gateway that fails to close", async () => {
    const { service, gateway } = await startConnected();
    gateway.gateway.close.mockRejectedValueOnce(new Error("runtime already gone"));
    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it("waits for a failed connection's cleanup without closing it again or reporting it", async () => {
    const { service, gateways, emitted } = startService();
    service.handle({ type: "connect", token, remember: false });
    const fake = itemAt(gateways, 0);
    const closing = deferred<void>();
    fake.gateway.close.mockImplementationOnce(() => closing.promise);
    fake.connection.reject(new GatewayFailure("auth_failed"));
    await settle();

    let shutDown = false;
    void service.shutdown().then(() => (shutDown = true));
    await settle();
    expect(shutDown).toBe(false);

    closing.resolve();
    await settle();
    expect(shutDown).toBe(true);
    expect(fake.gateway.close).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });

  it("closes the gateway of an aborted turn that is still ending, without reporting it", async () => {
    const { service, gateway, emitted, onRuntimeStuck } = await startConnected();
    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    emitEvent(itemAt(gateway.turns, 0), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH + 1) });
    emitted.length = 0;
    await service.shutdown();
    expect(gateway.gateway.close).toHaveBeenCalledOnce();

    itemAt(gateway.turns, 0).outcome.resolve("stopped");
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS);
    expect(emitted).toEqual([]);
    expect(onRuntimeStuck).not.toHaveBeenCalled();
  });
});

describe("deadlines", () => {
  it("leaves no deadline pending once each operation has settled", async () => {
    const { service, gateways } = startService();
    service.handle({ type: "connect", token, remember: false });
    itemAt(gateways, 0).connection.reject(new GatewayFailure("auth_failed"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    service.handle({ type: "connect", token, remember: false });
    const { connection, turns } = itemAt(gateways, 1);
    connection.resolve(account);
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    itemAt(turns, 0).outcome.resolve("complete");
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    emitEvent(itemAt(turns, 1), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH + 1) });
    itemAt(turns, 1).outcome.resolve("stopped");
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    service.handle({ type: "stop" });
    itemAt(turns, 2).outcome.resolve("stopped");
    await settle();
    expect(vi.getTimerCount()).toBe(0);

    service.handle({ type: "send", model: "gpt-5-mini", prompt });
    emitEvent(itemAt(turns, 3), { type: "delta", text: "a".repeat(MAX_OUTPUT_LENGTH + 1) });
    await service.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
