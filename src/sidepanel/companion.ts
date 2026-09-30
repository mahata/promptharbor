import { HOST_NAME } from "../protocol/identity.ts";
import { parseCompanionMessage, PROTOCOL_VERSION } from "../protocol/messages.ts";
import type { CompanionMessage, PanelMessage, RuntimeState } from "../protocol/messages.ts";

export type NativePort = {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
};

export type BridgeFailure =
  | "companion_not_installed"
  | "companion_forbidden"
  | "companion_start_failed"
  | "companion_exited"
  | "companion_protocol";

export type SessionMessage = Exclude<CompanionMessage, { type: "hello" } | { stage: "protocol" }>;

export type BridgeEvent =
  | { type: "ready"; sdkVersion: string; savedToken: boolean; runtime: RuntimeState; runtimeVersion?: string }
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
  let phase: "starting" | "ready" | "closed" = "starting";
  const port = connectNative(HOST_NAME);

  function disconnectForProtocolViolation() {
    phase = "closed";
    port.disconnect();
    onEvent({ type: "closed", failure: "companion_protocol" });
  }

  port.onMessage.addListener((value) => {
    if (phase === "closed") return;
    const message = parseCompanionMessage(value);
    if (!message) return disconnectForProtocolViolation();
    if (phase === "starting") {
      if (message.type !== "hello" || message.protocolVersion !== PROTOCOL_VERSION) return disconnectForProtocolViolation();
      phase = "ready";
      const { sdkVersion, savedToken, runtime, runtimeVersion } = message;
      return onEvent(
        runtimeVersion === undefined
          ? { type: "ready", sdkVersion, savedToken, runtime }
          : { type: "ready", sdkVersion, savedToken, runtime, runtimeVersion },
      );
    }
    if (!isSessionMessage(message)) return disconnectForProtocolViolation();
    onEvent({ type: "message", message });
  });

  port.onDisconnect.addListener(() => {
    const reason = readLastError();
    if (phase === "closed") return;
    phase = "closed";
    onEvent({ type: "closed", failure: (reason && FAILURE_BY_DISCONNECT_REASON.get(reason)) || "companion_exited" });
  });

  return {
    send(message) {
      if (phase !== "ready") return false;
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
