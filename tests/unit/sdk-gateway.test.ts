import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { CopilotGateway, Turn, TurnEvent } from "../../src/companion/gateway.ts";
import { createSdkGateway, GRACEFUL_STOP_TIMEOUT_MS } from "../../src/companion/sdk-gateway.ts";
import { MAX_MODELS } from "../../src/protocol/messages.ts";

const sdk = vi.hoisted(() => {
  type SdkEvent = Record<string, unknown>;

  const script = {
    start: async () => {},
    authStatus: async (): Promise<Record<string, unknown>> => ({ isAuthenticated: true, login: "octocat" }),
    models: async (): Promise<unknown[]> => [],
    stop: async (): Promise<Error[]> => [],
  };

  class FakeSession {
    readonly config: Record<string, unknown>;
    readonly handlers = new Set<(event: SdkEvent) => void>();
    readonly send = vi.fn(async (_options: { prompt: string }) => "message-1");
    readonly setModel = vi.fn(async (_model: string) => {});
    readonly abort = vi.fn(async () => {});
    readonly disconnectRequests = vi.fn();
    disconnectOutcome: () => Promise<void> = async () => {};

    constructor(config: Record<string, unknown>) {
      this.config = config;
    }

    disconnect() {
      this.disconnectRequests();
      return this.disconnectOutcome();
    }

    on(handler: (event: SdkEvent) => void) {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }

    emit(event: SdkEvent) {
      for (const handler of [...this.handlers]) handler(event);
    }
  }

  class FakeCopilotClient {
    static readonly instances: FakeCopilotClient[] = [];
    readonly options: Record<string, unknown>;
    readonly sessions: FakeSession[] = [];
    readonly start = vi.fn(() => script.start());
    readonly getAuthStatus = vi.fn(() => script.authStatus());
    readonly listModels = vi.fn(() => script.models());
    readonly createSession = vi.fn(async (config: Record<string, unknown>) => {
      const session = new FakeSession(config);
      this.sessions.push(session);
      return session;
    });
    readonly stop = vi.fn(() => script.stop());
    readonly forceStop = vi.fn(async () => {});

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeCopilotClient.instances.push(this);
    }
  }

  const RuntimeConnection = {
    forStdio: (options: Record<string, unknown>) => ({ kind: "stdio", ...options }),
  };

  return { script, FakeCopilotClient, FakeSession, RuntimeConnection };
});

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: sdk.FakeCopilotClient,
  RuntimeConnection: sdk.RuntimeConnection,
}));

const token = `github_pat_${"Q".repeat(82)}`;
const COPILOT_CLI_PATH = "/opt/homebrew/bin/copilot";
let cacheDirectory: string;
const idle = { type: "session.idle", data: {} };

type FakeSession = InstanceType<typeof sdk.FakeSession>;

function onlyClient() {
  expect(sdk.FakeCopilotClient.instances).toHaveLength(1);
  const [client] = sdk.FakeCopilotClient.instances;
  if (!client) throw new Error("expected a client");
  return client;
}

function homeOf(client: InstanceType<typeof sdk.FakeCopilotClient>) {
  const home = client.options.baseDirectory;
  if (typeof home !== "string") throw new Error("expected a base directory");
  return home;
}

async function connectedGateway() {
  const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
  await gateway.connect(token);
  return { gateway, client: onlyClient() };
}

async function startedTurn() {
  const { gateway, client } = await connectedGateway();
  const events: TurnEvent[] = [];
  const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: (event) => events.push(event) });
  await vi.waitFor(() => expect(client.sessions[0]?.send).toHaveBeenCalled());
  const [session] = client.sessions;
  if (!session) throw new Error("expected a session");
  return { gateway, client, session, turn, events };
}

async function answeredFirstTurn() {
  const started = await startedTurn();
  started.session.emit(idle);
  await expect(started.turn.outcome).resolves.toBe("complete");
  return started;
}

function sendPrompt(gateway: CopilotGateway, prompt: string, model = "gpt-5-mini") {
  return gateway.startTurn({ model, prompt, onEvent: () => {} });
}

async function answer(session: FakeSession | undefined, turn: Turn, prompt: string) {
  await vi.waitFor(() => expect(session?.send).toHaveBeenLastCalledWith({ prompt }));
  session?.emit(idle);
  await expect(turn.outcome).resolves.toBe("complete");
}

beforeEach(() => {
  sdk.FakeCopilotClient.instances.length = 0;
  sdk.script.start = async () => {};
  sdk.script.authStatus = async () => ({ isAuthenticated: true, login: "octocat" });
  sdk.script.models = async () => [];
  sdk.script.stop = async () => [];
  cacheDirectory = join(mkdtempSync(join(tmpdir(), "gateway-cache-")), "copilot-cli");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dirname(cacheDirectory), { recursive: true, force: true });
});

describe("connect", () => {
  it("starts an empty-mode runtime with only the panel's token and a private temporary home", async () => {
    vi.stubEnv("GH_TOKEN", "gho_ambient");
    vi.stubEnv("GITHUB_TOKEN", "ghp_ambient");
    // The SDK reads this too, so the gateway has to name the Copilot CLI it was given instead.
    vi.stubEnv("COPILOT_CLI_PATH", "/tmp/other-runtime");
    const { gateway, client } = await connectedGateway();
    const home = homeOf(client);

    expect(client.options).toEqual({
      mode: "empty",
      connection: {
        kind: "stdio",
        path: COPILOT_CLI_PATH,
        env: { HOME: cacheDirectory, TMPDIR: home, COPILOT_HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      baseDirectory: home,
      workingDirectory: home,
      gitHubToken: token,
      useLoggedInUser: false,
      logLevel: "error",
      clientInfo: { applicationName: "prompt-harbor" },
    });
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(client.start).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("starts the Copilot CLI it is given rather than a runtime of its own", async () => {
    const runtimePath = "/usr/local/bin/copilot";
    const gateway = createSdkGateway({ runtimePath, cacheDirectory });
    await gateway.connect(token);
    const client = onlyClient();
    const home = homeOf(client);

    expect(client.options.connection).toEqual({
      kind: "stdio",
      path: runtimePath,
      env: { HOME: cacheDirectory, TMPDIR: home, COPILOT_HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    await gateway.close();
  });

  it("returns the login and only enabled, well-formed models", async () => {
    sdk.script.models = async () => [
      { id: "gpt-5-mini", name: "GPT-5 mini", policy: { state: "enabled", terms: "" }, billing: { multiplier: 0 } },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", policy: { state: "enabled", terms: "" }, billing: { multiplier: 1 } },
      { id: "o3", name: "o3", policy: { state: "disabled", terms: "" }, billing: { multiplier: 1 } },
      { id: "gpt-4.1", name: "GPT-4.1", policy: { state: "unconfigured", terms: "" } },
      { id: "no-policy", name: "No policy" },
      { id: "", name: "Nameless id", policy: { state: "enabled", terms: "" } },
      { id: "odd-billing", name: "Odd billing", policy: { state: "enabled", terms: "" }, billing: { multiplier: -1 } },
    ];
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    await expect(gateway.connect(token)).resolves.toEqual({
      login: "octocat",
      models: [
        { id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 },
        { id: "odd-billing", name: "Odd billing" },
      ],
    });
    await gateway.close();
  });

  it("caps the model list and omits a missing login", async () => {
    sdk.script.authStatus = async () => ({ isAuthenticated: true });
    sdk.script.models = async () =>
      Array.from({ length: MAX_MODELS + 5 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        policy: { state: "enabled", terms: "" },
      }));
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    const account = await gateway.connect(token);
    expect(account.login).toBeUndefined();
    expect(account.models).toHaveLength(MAX_MODELS);
    await gateway.close();
  });

  it.each([
    ["the runtime fails to start", { start: async () => Promise.reject(new Error(`spawn failed ${token}`)) }, "sdk_start_failed"],
    ["the token is not authenticated", { authStatus: async () => ({ isAuthenticated: false, statusMessage: "Not authenticated" }) }, "auth_failed"],
    ["auth status cannot be read", { authStatus: async () => Promise.reject(new Error("rpc closed")) }, "auth_failed"],
    ["models cannot be listed", { models: async () => Promise.reject(new Error("403 Forbidden: {body}")) }, "models_unavailable"],
  ] as const)("reports a coded failure when %s", async (_description, override, code) => {
    Object.assign(sdk.script, override);
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    const failure = await gateway.connect(token).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure).toMatchObject({ code, message: code });
    await gateway.close();
  });

  it("does not start a runtime when closed before the SDK is ready", async () => {
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    const connecting = gateway.connect(token);
    await gateway.close();
    await expect(connecting).rejects.toBeInstanceOf(GatewayFailure);
    expect(sdk.FakeCopilotClient.instances).toHaveLength(0);
  });

  it("stops a runtime that was closed while starting", async () => {
    let finishStart = () => {};
    sdk.script.start = () => new Promise<void>((resolve) => (finishStart = resolve));
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    const connecting = gateway.connect(token);
    await vi.waitFor(() => expect(sdk.FakeCopilotClient.instances[0]?.start).toHaveBeenCalled());
    const client = onlyClient();
    await gateway.close();
    finishStart();

    await expect(connecting).rejects.toBeInstanceOf(GatewayFailure);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.getAuthStatus).not.toHaveBeenCalled();
    expect(existsSync(homeOf(client))).toBe(false);
  });
});

describe("startTurn", () => {
  it("creates a tool-less, permission-denying session in the temporary home", async () => {
    const { gateway, client, session } = await startedTurn();
    expect(session.config).toEqual({
      model: "gpt-5-mini",
      streaming: true,
      availableTools: [],
      onPermissionRequest: expect.any(Function),
      infiniteSessions: { enabled: false },
      workingDirectory: homeOf(client),
    });
    const onPermissionRequest = session.config.onPermissionRequest as () => unknown;
    expect(onPermissionRequest()).toEqual({ kind: "reject" });
    expect(session.send).toHaveBeenCalledWith({ prompt: "Say hi" });
    await gateway.close();
  });

  it("forwards root-agent deltas and usage, then completes on idle and keeps the session open", async () => {
    const { gateway, session, turn, events } = await startedTurn();
    session.emit({ type: "assistant.message_delta", data: { deltaContent: "Connection ", messageId: "m1" } });
    session.emit({ type: "assistant.message_delta", agentId: "sub-agent", data: { deltaContent: "noise", messageId: "m2" } });
    session.emit({ type: "assistant.message_delta", data: { deltaContent: "confirmed.", messageId: "m1" } });
    session.emit({ type: "assistant.usage", data: { model: "gpt-5-mini", cost: 0, inputTokens: 12 } });
    session.emit({ type: "assistant.usage", data: { model: "gpt-5-mini", cost: Number.NaN } });
    session.emit({ type: "assistant.usage", agentId: "sub-agent", data: { model: "other", cost: 1 } });
    session.emit(idle);

    await expect(turn.outcome).resolves.toBe("complete");
    expect(events).toEqual([
      { type: "delta", text: "Connection " },
      { type: "delta", text: "confirmed." },
      { type: "usage", model: "gpt-5-mini", cost: 0 },
      { type: "usage", model: "gpt-5-mini" },
    ]);
    expect(session.disconnectRequests).not.toHaveBeenCalled();
    await gateway.close();
  });

  it("ignores an idle event from a sub-agent", async () => {
    const { gateway, session, turn } = await startedTurn();
    session.emit({ type: "session.idle", agentId: "sub-agent", data: {} });
    session.emit({ type: "session.idle", data: { aborted: true } });
    await expect(turn.outcome).resolves.toBe("stopped");
    await gateway.close();
  });

  it.each([
    ["authentication", "auth_failed"],
    ["authorization", "not_authorized"],
    ["quota", "quota_exceeded"],
    ["rate_limit", "rate_limited"],
    ["context_limit", "context_limit"],
    ["query", "send_failed"],
  ])("maps a %s session error to %s without its server text", async (errorType, code) => {
    const { gateway, session, turn } = await startedTurn();
    session.emit({ type: "session.error", data: { errorType, message: `401 Unauthorized: ${token}`, statusCode: 401 } });
    session.emit(idle);

    const failure = await turn.outcome.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayFailure);
    expect(failure).toMatchObject({ code, message: code });
    expect(session.disconnectRequests).not.toHaveBeenCalled();
    await gateway.close();
  });

  it("reports a session that cannot be created, then creates one on the next turn", async () => {
    const { gateway, client } = await connectedGateway();
    client.createSession.mockImplementationOnce(async () => Promise.reject(new Error(`SDK session authentication failed: ${token}`)));
    const failedTurn = sendPrompt(gateway, "Say hi");
    await expect(failedTurn.outcome).rejects.toMatchObject({ code: "send_failed", message: "send_failed" });

    const nextTurn = sendPrompt(gateway, "Say hi");
    await vi.waitFor(() => expect(client.sessions).toHaveLength(1));
    await answer(client.sessions[0], nextTurn, "Say hi");
    expect(client.createSession).toHaveBeenCalledTimes(2);
    await gateway.close();
  });

  it("aborts the running session and reports the stopped outcome", async () => {
    const { gateway, session, turn } = await startedTurn();
    await turn.abort();
    expect(session.abort).toHaveBeenCalledOnce();
    session.emit({ type: "session.idle", data: { aborted: true } });
    await expect(turn.outcome).resolves.toBe("stopped");
    await gateway.close();
  });

  it("stops before sending when aborted while the session is being created, and keeps the session", async () => {
    const { gateway, client } = await connectedGateway();
    const turn = sendPrompt(gateway, "Say hi");
    await turn.abort();
    await expect(turn.outcome).resolves.toBe("stopped");
    const [session] = client.sessions;
    expect(session?.send).not.toHaveBeenCalled();

    const nextTurn = sendPrompt(gateway, "Try again");
    await answer(session, nextTurn, "Try again");
    expect(client.createSession).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("does not send when the gateway closes while the session is being created", async () => {
    const { gateway, client } = await connectedGateway();
    let releaseSession = () => {};
    client.createSession.mockImplementationOnce(async (config: Record<string, unknown>) => {
      await new Promise<void>((resolve) => (releaseSession = resolve));
      const session = new sdk.FakeSession(config);
      client.sessions.push(session);
      return session;
    });
    const turn = sendPrompt(gateway, "Say hi");
    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalled());
    await gateway.close();
    releaseSession();

    await expect(turn.outcome).rejects.toMatchObject({ code: "send_failed" });
    expect(client.sessions[0]?.send).not.toHaveBeenCalled();
  });

  it("refuses to start a turn before connecting", async () => {
    const gateway = createSdkGateway({ runtimePath: COPILOT_CLI_PATH, cacheDirectory });
    const turn = gateway.startTurn({ model: "gpt-5-mini", prompt: "Say hi", onEvent: () => {} });
    await expect(turn.outcome).rejects.toMatchObject({ code: "send_failed" });
  });

  it("refuses to continue the conversation after closing", async () => {
    const { gateway, session } = await answeredFirstTurn();
    await gateway.close();
    await expect(sendPrompt(gateway, "Still there?").outcome).rejects.toMatchObject({ code: "send_failed" });
    expect(session.send).toHaveBeenCalledOnce();
  });
});

describe("conversation", () => {
  it("sends every prompt of the conversation to one session", async () => {
    const { gateway, client, session } = await answeredFirstTurn();
    const secondTurn = sendPrompt(gateway, "And again");
    await answer(session, secondTurn, "And again");

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(session.send.mock.calls).toEqual([[{ prompt: "Say hi" }], [{ prompt: "And again" }]]);
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.disconnectRequests).not.toHaveBeenCalled();
    await gateway.close();
  });

  it("switches the session's model before sending the next prompt, and only when the model changes", async () => {
    const { gateway, client, session } = await answeredFirstTurn();
    let finishSwitch = () => {};
    session.setModel.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSwitch = resolve)));
    const switchedTurn = sendPrompt(gateway, "Now you", "claude-sonnet-4.5");
    await vi.waitFor(() => expect(session.setModel).toHaveBeenCalledWith("claude-sonnet-4.5"));
    expect(session.send).toHaveBeenCalledOnce();

    finishSwitch();
    await answer(session, switchedTurn, "Now you");
    const sameModelTurn = sendPrompt(gateway, "And again", "claude-sonnet-4.5");
    await answer(session, sameModelTurn, "And again");

    expect(session.setModel).toHaveBeenCalledOnce();
    expect(client.createSession).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("fails a turn without sending when the model cannot be switched, then retries the switch", async () => {
    const { gateway, session } = await answeredFirstTurn();
    session.setModel.mockImplementationOnce(async () => Promise.reject(new Error(`model switch failed: ${token}`)));
    const failedTurn = sendPrompt(gateway, "Now you", "claude-sonnet-4.5");
    await expect(failedTurn.outcome).rejects.toMatchObject({ code: "send_failed", message: "send_failed" });
    expect(session.send).toHaveBeenCalledOnce();

    const retriedTurn = sendPrompt(gateway, "Now you", "claude-sonnet-4.5");
    await answer(session, retriedTurn, "Now you");
    expect(session.setModel).toHaveBeenCalledTimes(2);
    await gateway.close();
  });

  it.each([
    ["never finishes", () => new Promise<void>(() => {})],
    ["fails", async () => Promise.reject(new Error("connection lost"))],
  ])("starts a new conversation in a fresh session even when disconnecting the old one %s", async (_description, disconnect) => {
    const { gateway, client, session } = await answeredFirstTurn();
    session.disconnectOutcome = disconnect;

    gateway.startNewConversation();
    expect(session.disconnectRequests).toHaveBeenCalledOnce();
    const freshTurn = sendPrompt(gateway, "Fresh start");
    await vi.waitFor(() => expect(client.sessions).toHaveLength(2));
    await answer(client.sessions[1], freshTurn, "Fresh start");

    expect(session.send).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it("starts a new conversation before any turn without creating a session", async () => {
    const { gateway, client } = await connectedGateway();
    gateway.startNewConversation();
    expect(client.createSession).not.toHaveBeenCalled();

    const turn = sendPrompt(gateway, "Say hi");
    await vi.waitFor(() => expect(client.sessions).toHaveLength(1));
    await answer(client.sessions[0], turn, "Say hi");
    await gateway.close();
  });
});

describe("close", () => {
  it("stops the runtime and removes the temporary home", async () => {
    const { gateway, client } = await connectedGateway();
    await gateway.close();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forceStop).not.toHaveBeenCalled();
    expect(existsSync(homeOf(client))).toBe(false);
  });

  it("leaves closing the conversation's session to the runtime stop", async () => {
    const { gateway, client, session } = await answeredFirstTurn();
    session.disconnectOutcome = () => new Promise<void>(() => {});
    await gateway.close();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(existsSync(homeOf(client))).toBe(false);
  });

  it.each([
    ["reports cleanup errors", async () => [new Error("session cleanup failed")]],
    ["throws", async () => Promise.reject(new Error("connection lost"))],
  ])("force-stops the runtime when a graceful stop %s", async (_description, stop) => {
    sdk.script.stop = stop;
    const { gateway, client } = await connectedGateway();
    await gateway.close();
    expect(client.forceStop).toHaveBeenCalledOnce();
    expect(existsSync(homeOf(client))).toBe(false);
  });

  it("force-stops a runtime that has not stopped gracefully in time", async () => {
    sdk.script.stop = () => new Promise<Error[]>(() => {});
    const { gateway, client } = await connectedGateway();
    vi.useFakeTimers();
    const closing = gateway.close();
    await vi.advanceTimersByTimeAsync(GRACEFUL_STOP_TIMEOUT_MS - 1);
    expect(client.forceStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(client.forceStop).toHaveBeenCalledOnce();
    expect(existsSync(homeOf(client))).toBe(false);
  });

  it("leaves no timer behind after a prompt graceful stop", async () => {
    const { gateway } = await connectedGateway();
    vi.useFakeTimers();
    await gateway.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
