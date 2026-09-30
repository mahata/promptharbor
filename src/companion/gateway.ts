import type { ErrorCode, ModelSummary, TurnOutcome } from "../protocol/messages.ts";

export type ConnectedAccount = { login?: string; models: ModelSummary[] };

export type TurnEvent = { type: "delta"; text: string } | { type: "usage"; model: string; cost?: number };

export type TurnRequest = { model: string; prompt: string; onEvent: (event: TurnEvent) => void };

export type Turn = { outcome: Promise<TurnOutcome>; abort: () => Promise<void> };

export type CopilotGateway = {
  connect: (token: string) => Promise<ConnectedAccount>;
  startTurn: (request: TurnRequest) => Turn;
  startNewConversation: () => void;
  close: () => Promise<void>;
};

export const CONNECT_FAILURE_CODES = [
  "runtime_unsupported",
  "sdk_start_failed",
  "auth_failed",
  "models_unavailable",
] as const satisfies readonly ErrorCode<"connect">[];

export const TURN_FAILURE_CODES = [
  "auth_failed",
  "not_authorized",
  "quota_exceeded",
  "rate_limited",
  "context_limit",
  "send_failed",
] as const satisfies readonly ErrorCode<"send">[];

export type ConnectFailureCode = (typeof CONNECT_FAILURE_CODES)[number];
export type TurnFailureCode = (typeof TURN_FAILURE_CODES)[number];
export type GatewayFailureCode = ConnectFailureCode | TurnFailureCode;

export class GatewayFailure extends Error {
  readonly code: GatewayFailureCode;

  constructor(code: GatewayFailureCode) {
    super(code);
    this.name = "GatewayFailure";
    this.code = code;
  }
}
