import { beforeEach, describe, expect, it } from "vitest";
import { openCompanionBridge } from "../../src/sidepanel/companion.ts";
import type { BridgeEvent, NativePort } from "../../src/sidepanel/companion.ts";
import { HOST_NAME } from "../../src/protocol/identity.ts";

let lastErrorMessage: string | undefined;

class FakePort implements NativePort {
  readonly posted: unknown[] = [];
  disconnectCalls = 0;
  private open = true;
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];
  readonly onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) };
  readonly onDisconnect = { addListener: (listener: () => void) => void this.disconnectListeners.push(listener) };

  postMessage(message: unknown) {
    if (!this.open) throw new Error("Attempting to use a disconnected port object");
    this.posted.push(message);
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.open = false;
  }

  deliver(message: unknown) {
    for (const listener of this.messageListeners) listener(message);
  }

  hostDisconnects(reason?: string) {
    this.open = false;
    lastErrorMessage = reason;
    for (const listener of this.disconnectListeners) listener();
    lastErrorMessage = undefined;
  }
}

const hello = { type: "hello", protocolVersion: 4, sdkVersion: "1.0.14", savedToken: true, runtime: "ready", runtimeVersion: "1.0.89-3" };
let port: FakePort;
let events: BridgeEvent[];
let connectedHostNames: string[];

function openBridge() {
  return openCompanionBridge({
    connectNative: (hostName) => {
      connectedHostNames.push(hostName);
      return port;
    },
    readLastError: () => lastErrorMessage,
    onEvent: (event) => events.push(event),
  });
}

function readyBridge() {
  const bridge = openBridge();
  port.deliver(hello);
  events.length = 0;
  return bridge;
}

beforeEach(() => {
  port = new FakePort();
  events = [];
  connectedHostNames = [];
  lastErrorMessage = undefined;
});

describe("openCompanionBridge", () => {
  it("connects to the pinned native host and reports readiness and any saved PAT after a matching hello", () => {
    openBridge();
    expect(connectedHostNames).toEqual([HOST_NAME]);
    expect(events).toEqual([]);

    port.deliver(hello);
    expect(events).toEqual([{ type: "ready", sdkVersion: "1.0.14", savedToken: true, runtime: "ready", runtimeVersion: "1.0.89-3" }]);
  });

  it.each([
    ["Specified native messaging host not found.", "companion_not_installed"],
    ["Access to the specified native messaging host is forbidden.", "companion_forbidden"],
    ["Failed to start native messaging host.", "companion_start_failed"],
    ["Error when communicating with the native messaging host.", "companion_protocol"],
    ["Native host has exited.", "companion_exited"],
    ["A reason Chrome may add later.", "companion_exited"],
    [undefined, "companion_exited"],
  ])("maps a disconnect with %j to %s", (reason, failure) => {
    openBridge();
    port.hostDisconnects(reason);
    expect(events).toEqual([{ type: "closed", failure }]);
  });

  it("forwards validated session messages once the companion is ready", () => {
    readyBridge();
    const sessionMessages = [
      { type: "connected", login: "octocat", models: [{ id: "gpt-5-mini", name: "GPT-5 mini", multiplier: 0 }] },
      { type: "delta", text: "<b>日本語</b>" },
      { type: "usage", model: "gpt-5-mini", cost: 0 },
      { type: "done", outcome: "stopped" },
      { type: "credential", saved: false },
      { type: "error", stage: "send", code: "quota_exceeded" },
      { type: "error", stage: "credential", code: "save_failed" },
    ];
    for (const message of sessionMessages) port.deliver(message);

    expect(events).toEqual(sessionMessages.map((message) => ({ type: "message", message })));
  });

  it.each([
    ["a session message before hello", [{ type: "done", outcome: "complete" }]],
    ["a hello from an older companion", [{ type: "hello", protocolVersion: 1, sdkVersion: "1.0.14" }]],
    ["a hello for another protocol version", [{ ...hello, protocolVersion: 2 }]],
    ["a second hello", [hello, hello]],
    ["a malformed message", [hello, { type: "delta", text: 42 }]],
    ["an unknown message", [hello, { type: "eval", code: "alert(1)" }]],
    ["a protocol error from the companion", [hello, { type: "error", stage: "protocol", code: "invalid_message" }]],
  ])("disconnects on %s", (_description, messages) => {
    openBridge();
    for (const message of messages) port.deliver(message);

    expect(events.at(-1)).toEqual({ type: "closed", failure: "companion_protocol" });
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
    expect(port.disconnectCalls).toBe(1);
  });

  it("reports only the first closure and ignores anything after it", () => {
    openBridge();
    port.deliver({ type: "done", outcome: "complete" });
    port.deliver(hello);
    port.hostDisconnects("Native host has exited.");

    expect(events).toEqual([{ type: "closed", failure: "companion_protocol" }]);
  });

  it("posts panel messages only while the companion is ready", () => {
    const bridge = openBridge();
    expect(bridge.send({ type: "stop" })).toBe(false);

    port.deliver(hello);
    expect(bridge.send({ type: "send", model: "gpt-5-mini", prompt: "Say hello." })).toBe(true);
    expect(port.posted).toEqual([{ type: "send", model: "gpt-5-mini", prompt: "Say hello." }]);

    port.hostDisconnects("Native host has exited.");
    expect(bridge.send({ type: "stop" })).toBe(false);
    expect(port.posted).toHaveLength(1);
  });

  it("treats a port that disconnected underneath it as unable to send", () => {
    const bridge = readyBridge();
    port.disconnect();
    expect(bridge.send({ type: "stop" })).toBe(false);
  });

  it("closes the port once without reporting a failure", () => {
    const bridge = readyBridge();
    bridge.close();
    bridge.close();
    port.deliver({ type: "delta", text: "late" });

    expect(port.disconnectCalls).toBe(1);
    expect(events).toEqual([]);
    expect(bridge.send({ type: "stop" })).toBe(false);
  });
});
