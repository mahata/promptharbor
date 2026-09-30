import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayFailure } from "../../src/companion/gateway.ts";
import type { CopilotGateway } from "../../src/companion/gateway.ts";
import type { CredentialStore } from "../../src/companion/keychain.ts";
import { runCompanion } from "../../src/companion/run.ts";
import type { RuntimeStatus } from "../../src/companion/runtime.ts";
import type { TurnOutcome } from "../../src/protocol/messages.ts";

const FAKE_MODELS = [
  { id: "fake-other", name: "Fake other reply", multiplier: 1 },
  { id: "fake-reply", name: "Fake reply", multiplier: 0 },
  { id: "fake-slow", name: "Fake slow reply", multiplier: 1 },
  { id: "fake-quota", name: "Fake quota failure", multiplier: 0.33 },
  { id: "fake-crash", name: "Fake crash", multiplier: 1 },
];
const INERT_MARKUP = '<img src="x" onerror="alert(1)">';
const STEP_DELAY_MS = 20;

const runningMarker = join(requiredEnvironment("FAKE_COMPANION_STATE_DIR"), `${process.pid}.running`);
const keychainPath = requiredEnvironment("FAKE_KEYCHAIN_PATH");
// A test writes this file to pretend the Copilot CLI is missing or too old. It is read on every
// lookup, so restarting the companion with Try again picks up a change.
const runtimeStatePath = join(requiredEnvironment("FAKE_COMPANION_STATE_DIR"), "runtime-state");
writeFileSync(runningMarker, "");

const companion = runCompanion({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  args: process.argv.slice(2),
  createGateway: createFakeGateway,
  resolveRuntime: async () => fakeRuntimeStatus(),
  store: createFakeKeychain(),
  sdkVersion: `fake-${process.pid}`,
});
process.once("SIGTERM", () => void companion.shutdown());
process.exitCode = await companion.done;
rmSync(runningMarker, { force: true });

function fakeRuntimeStatus(): RuntimeStatus {
  const state = existsSync(runtimeStatePath) ? readFileSync(runtimeStatePath, "utf8").trim() : "ready";
  if (state === "missing") return { state: "missing" };
  if (state === "unsupported") return { state: "unsupported", path: "/opt/homebrew/bin/copilot" };
  return { state: "ready", path: "/opt/homebrew/bin/copilot", version: "1.0.89-3" };
}

function createFakeGateway(): CopilotGateway {
  let turnsInConversation = 0;

  return {
    async connect(token) {
      await pause(STEP_DELAY_MS);
      if (token.includes("CRASH")) crash();
      if (token.includes("DENIED")) throw new GatewayFailure("auth_failed");
      if (token.includes("NOMODELS")) return { login: "octocat", models: [] };
      return { login: "octocat", models: FAKE_MODELS };
    },

    startTurn({ model, prompt, onEvent }) {
      appendFileSync(`${keychainPath}.prompts`, `${JSON.stringify(prompt)}\n`);
      turnsInConversation += 1;
      const reply = [`Reply ${turnsInConversation} (${model}) to: `, prompt, " 日本語 ", INERT_MARKUP];
      let abortRequested = false;
      let wakeOnAbort = () => {};
      const abortReceived = new Promise<void>((resolve) => (wakeOnAbort = resolve));
      const outcome = (async (): Promise<TurnOutcome> => {
        await pause(STEP_DELAY_MS);
        if (model === "fake-quota") throw new GatewayFailure("quota_exceeded");
        if (model === "fake-slow" || model === "fake-crash") {
          onEvent({ type: "delta", text: "Partial reply " });
          if (model === "fake-crash") {
            await pause(STEP_DELAY_MS);
            crash();
          }
          await abortReceived;
          return "stopped";
        }
        for (const text of reply) {
          if (abortRequested) return "stopped";
          onEvent({ type: "delta", text });
          await pause(STEP_DELAY_MS);
        }
        onEvent({ type: "usage", model, cost: 0 });
        return "complete";
      })();
      return {
        outcome,
        async abort() {
          abortRequested = true;
          wakeOnAbort();
        },
      };
    },

    startNewConversation() {
      turnsInConversation = 0;
    },

    async close() {},
  };
}

function createFakeKeychain(): CredentialStore {
  return {
    async hasSavedToken() {
      return existsSync(keychainPath);
    },

    async loadToken() {
      await pause(STEP_DELAY_MS);
      const token = savedFakeToken();
      if (token?.includes("LOCKED")) throw new Error("The fake Keychain is locked.");
      if (token?.includes("VANISH")) {
        rmSync(keychainPath, { force: true });
        return undefined;
      }
      return token;
    },

    async saveToken(token) {
      await pause(STEP_DELAY_MS);
      if (token.includes("HOLD")) await waitForKeychainRelease();
      if (token.includes("NOSAVE")) throw new Error("The fake Keychain refused to save this PAT.");
      writeFileSync(keychainPath, token);
    },

    async forgetToken() {
      await pause(STEP_DELAY_MS);
      const token = savedFakeToken();
      if (token?.includes("HOLD")) await waitForKeychainRelease();
      if (token?.includes("NOFORGET")) throw new Error("The fake Keychain refused to delete this PAT.");
      rmSync(keychainPath, { force: true });
      return token !== undefined;
    },
  };
}

async function waitForKeychainRelease() {
  const releasePath = `${keychainPath}.release`;
  const deadline = Date.now() + 10_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("The test never released the fake Keychain.");
    await pause(STEP_DELAY_MS);
  }
  rmSync(releasePath);
}

function savedFakeToken() {
  return existsSync(keychainPath) ? readFileSync(keychainPath, "utf8") : undefined;
}

function crash(): never {
  rmSync(runningMarker, { force: true });
  process.exit(3);
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
