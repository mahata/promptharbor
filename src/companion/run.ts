import type { Readable, Writable } from "node:stream";
import { createFrameDecoder, encodeFrame, FrameError } from "./framing.ts";
import type { CopilotGateway } from "./gateway.ts";
import type { CredentialStore } from "./keychain.ts";
import type { RuntimeStatus } from "./runtime.ts";
import { createCompanionService } from "./service.ts";
import { EXTENSION_ORIGIN } from "../protocol/identity.ts";
import { parsePanelMessage, PROTOCOL_VERSION } from "../protocol/messages.ts";
import type { CompanionMessage, ErrorCode } from "../protocol/messages.ts";

const CLEAN_EXIT = 0;
const FAILED_EXIT = 1;
export const REFUSAL_NOTICE = "This companion only runs when Chrome starts it for the Prompt Harbor extension.\n";

export type RunCompanionOptions = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  args: readonly string[];
  createGateway: (runtimePath: string) => CopilotGateway;
  resolveRuntime: () => Promise<RuntimeStatus>;
  store: CredentialStore;
  sdkVersion: string;
};

export type RunningCompanion = { done: Promise<number>; shutdown: () => Promise<number> };

export function runCompanion({
  stdin,
  stdout,
  stderr,
  args,
  createGateway,
  resolveRuntime,
  store,
  sdkVersion,
}: RunCompanionOptions): RunningCompanion {
  if (args[0] !== EXTENSION_ORIGIN) {
    stderr.write(REFUSAL_NOTICE);
    const refused = Promise.resolve(FAILED_EXIT);
    return { done: refused, shutdown: () => refused };
  }

  let exiting = false;
  let reportExit: (exitCode: number) => void = () => {};
  const done = new Promise<number>((resolve) => (reportExit = resolve));

  function emit(message: CompanionMessage) {
    if (!exiting && stdout.writable) stdout.write(encodeFrame(message));
  }

  let service: ReturnType<typeof createCompanionService> | undefined;
  const decoder = createFrameDecoder((frame) => {
    if (exiting) return;
    const message = parsePanelMessage(frame);
    // Standard input is only read from greetThenListen, which creates the service first, so no
    // frame can reach this before there is one to handle it.
    if (message && service) service.handle(message);
    else failProtocol("invalid_message");
  });

  function receiveChunk(chunk: Buffer) {
    try {
      decoder.push(chunk);
    } catch (error) {
      failProtocol(error instanceof FrameError ? error.code : "invalid_message");
    }
  }

  function failProtocol(code: ErrorCode<"protocol">) {
    if (exiting) return;
    emit({ type: "error", stage: "protocol", code });
    exit(FAILED_EXIT);
  }

  function exit(exitCode: number) {
    if (exiting) return;
    exiting = true;
    stdin.off("data", receiveChunk);
    stdin.destroy();
    const stopped = service?.shutdown() ?? Promise.resolve();
    void stopped.then(() => reportExit(exitCode));
  }

  function greetThenListen(savedToken: boolean, runtime: RuntimeStatus) {
    if (exiting) return;
    service = createCompanionService({
      createGateway,
      runtime,
      resolveRuntime,
      store,
      emit,
      onRuntimeStuck: () => exit(FAILED_EXIT),
    });
    const hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, sdkVersion, savedToken, runtime: runtime.state } as const;
    const runtimeVersion = runtime.state === "missing" ? undefined : runtime.version;
    emit(runtimeVersion === undefined ? hello : { ...hello, runtimeVersion });
    stdin.on("end", () => exit(CLEAN_EXIT));
    stdin.on("data", receiveChunk);
  }

  stdout.on("error", () => exit(FAILED_EXIT));
  stdin.on("error", () => exit(FAILED_EXIT));
  // Looking for the Copilot CLI up front lets the panel explain a missing one before a PAT is
  // pasted. Neither lookup may keep the companion from greeting Chrome, so both fall back.
  void Promise.all([
    store.hasSavedToken().catch(() => false),
    resolveRuntime().catch((): RuntimeStatus => ({ state: "missing" })),
  ]).then(([savedToken, runtime]) => greetThenListen(savedToken, runtime));

  return {
    done,
    shutdown() {
      exit(CLEAN_EXIT);
      return done;
    },
  };
}
