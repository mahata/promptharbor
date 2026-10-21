import { HOST_NAME } from "../protocol/identity.ts";
import { parseCompanionMessage, parseHelloEnvelope, PROTOCOL_VERSION } from "../protocol/messages.ts";
import type { CompanionMessage, PanelMessage, RuntimeState } from "../protocol/messages.ts";

export type NativePort = {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
};

export type ProtocolMismatch = "companion_outdated" | "extension_outdated";

export type BridgeFailure =
  | "companion_not_installed"
  | "companion_forbidden"
  | "companion_start_failed"
  | "companion_exited"
  | "companion_protocol"
  | ProtocolMismatch;

export type SessionMessage = Exclude<CompanionMessage, { type: "hello" } | { stage: "protocol" }>;

export type BridgeEvent =
  | { type: "ready"; sdkVersion: string; savedToken: boolean; runtime: RuntimeState; runtimeVersion?: string }
  | { type: "mismatch"; failure: ProtocolMismatch; savedToken: boolean }
  | { type: "message"; message: SessionMessage }
  | { type: "closed"; failure: BridgeFailure };

export type CompanionBridge = {
  send: (message: PanelMessage) => boolean;
  close: () => void;
};

type CompanionBridgeOptions = {
  connectNative: (hostName: string) => NativePort;
  readLastError: () => string | undefined;
  onEvent: (event: BridgeEvent) => void;
};

const FAILURE_BY_DISCONNECT_REASON = new Map<string, BridgeFailure>([
  ["Specified native messaging host not found.", "companion_not_installed"],
  ["Access to the specified native messaging host is forbidden.", "companion_forbidden"],
  ["Failed to start native messaging host.", "companion_start_failed"],
  ["Error when communicating with the native messaging host.", "companion_protocol"],
]);

export function openCompanionBridge({ connectNative, readLastError, onEvent }: CompanionBridgeOptions): CompanionBridge {
  let phase: "starting" | "ready" | "mismatched" | "closed" = "starting";
  // Once the versions disagree, updating one side is the fix for whatever goes wrong next.
  let mismatch: ProtocolMismatch | undefined;
  const port = connectNative(HOST_NAME);

  function disconnect(failure: BridgeFailure) {
    phase = "closed";
    port.disconnect();
    onEvent({ type: "closed", failure });
  }

  function greet(value: unknown) {
    const envelope = parseHelloEnvelope(value);
    if (!envelope) return disconnect("companion_protocol");
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      phase = "mismatched";
      mismatch = envelope.protocolVersion < PROTOCOL_VERSION ? "companion_outdated" : "extension_outdated";
      return onEvent({ type: "mismatch", failure: mismatch, savedToken: envelope.savedToken });
    }
    const hello = parseCompanionMessage(value);
    if (hello?.type !== "hello") return disconnect("companion_protocol");
    phase = "ready";
    const { sdkVersion, savedToken, runtime, runtimeVersion } = hello;
    onEvent(
      runtimeVersion === undefined
        ? { type: "ready", sdkVersion, savedToken, runtime }
        : { type: "ready", sdkVersion, savedToken, runtime, runtimeVersion },
    );
  }

  port.onMessage.addListener((value) => {
    if (phase === "closed") return;
    if (phase === "starting") return greet(value);
    const message = parseCompanionMessage(value);
    if (mismatch !== undefined) {
      if (message && answersForget(message)) return onEvent({ type: "message", message });
      return disconnect(mismatch);
    }
    if (!message || !isSessionMessage(message)) return disconnect("companion_protocol");
    onEvent({ type: "message", message });
  });

  port.onDisconnect.addListener(() => {
    const reason = readLastError();
    if (phase === "closed") return;
    phase = "closed";
    onEvent({
      type: "closed",
      failure: mismatch ?? ((reason && FAILURE_BY_DISCONNECT_REASON.get(reason)) || "companion_exited"),
    });
  });

  return {
    send(message) {
      // forget is the only panel message every protocol version keeps.
      if (phase !== "ready" && !(phase === "mismatched" && message.type === "forget")) return false;
      try {
        port.postMessage(message);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (phase === "closed") return;
      phase = "closed";
      port.disconnect();
    },
  };
}

function isSessionMessage(message: CompanionMessage): message is SessionMessage {
  return message.type !== "hello" && !(message.type === "error" && message.stage === "protocol");
}

function answersForget(message: CompanionMessage): message is SessionMessage {
  return (message.type === "credential" && !message.saved) || (message.type === "error" && message.code === "forget_failed");
}
