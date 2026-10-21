import { describe, expect, it } from "vitest";
import { HOST_NAME } from "../../src/protocol/identity.ts";
import {
  BRIDGE_FAILURE_TEXT,
  CONNECT_ERROR_TEXT,
  CREDENTIAL_ERROR_TEXT,
  modelOptionLabel,
  PAGE_CAPTURE_ERROR_TEXT,
  pageCaptureErrorText,
  promptTooLongText,
  SAVED_TOKEN_REJECTED_TEXT,
  SEND_ERROR_TEXT,
} from "../../src/sidepanel/copy.ts";

describe("side panel copy", () => {
  it("labels models with the billing multiplier the SDK reports", () => {
    expect(modelOptionLabel({ id: "gpt-5", name: "GPT-5", multiplier: 0.33 })).toBe("GPT-5 (0.33×)");
    expect(modelOptionLabel({ id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 })).toBe("GPT-4.1 (0×)");
  });

  it("shows only the model name when its multiplier is undefined", () => {
    expect(modelOptionLabel({ id: "mystery", name: "Mystery" })).toBe("Mystery");
  });

  it("states the companion limits a request can hit", () => {
    expect(SEND_ERROR_TEXT.output_limit).toContain("65,536 characters");
    expect(SEND_ERROR_TEXT.timeout).toContain("5 minutes");
    expect(CONNECT_ERROR_TEXT.timeout).toContain("60 seconds");
  });

  it("explains a prompt that is too long to send", () => {
    expect(promptTooLongText(40_000)).toBe("This prompt is 40,000 characters. Shorten it to 32,768 or fewer to send.");
  });

  it("appends Chrome's reason only when it gave one", () => {
    expect(pageCaptureErrorText("page_restricted")).toBe(PAGE_CAPTURE_ERROR_TEXT.page_restricted);
    expect(pageCaptureErrorText("page_unreadable", "No tab with id: 7.")).toBe(
      `${PAGE_CAPTURE_ERROR_TEXT.page_unreadable} Chrome said: No tab with id: 7.`,
    );
  });

  it("names Prompt Harbor, not Copilot, as what reads a tab", () => {
    expect(PAGE_CAPTURE_ERROR_TEXT.page_access_needed).toContain("Chrome has not given Prompt Harbor access to this tab");
    expect(PAGE_CAPTURE_ERROR_TEXT.page_unreadable).toBe("Prompt Harbor could not read this tab, so nothing was sent.");
    for (const text of Object.values(PAGE_CAPTURE_ERROR_TEXT)) expect(text).not.toContain("Copilot");
  });

  it("tells the user how to start over when the conversation outgrows the model's context window", () => {
    expect(SEND_ERROR_TEXT.context_limit).toContain("context window");
    expect(SEND_ERROR_TEXT.context_limit).toContain("New chat");
  });

  it("tells the user how to install a missing companion and retry", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("companion package");
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).toContain("Try again");
    expect(BRIDGE_FAILURE_TEXT.companion_not_installed).not.toContain("pnpm");
  });

  it("tells the user to reinstall a companion that Chrome cannot start", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_start_failed).toContain("companion package");
    expect(BRIDGE_FAILURE_TEXT.companion_start_failed).toContain("Try again");
    expect(BRIDGE_FAILURE_TEXT.companion_start_failed).not.toContain("Node.js");
  });

  it("tells the user to rebuild and reload the extension when the companion sends a message the panel does not accept", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("pnpm build");
    expect(BRIDGE_FAILURE_TEXT.companion_protocol).toContain("chrome://extensions");
  });

  it("tells the user to install a newer companion when the installed one is too old for the extension", () => {
    expect(BRIDGE_FAILURE_TEXT.companion_outdated).toContain("companion on this Mac is too old");
    expect(BRIDGE_FAILURE_TEXT.companion_outdated).toContain("latest Prompt Harbor companion package");
    expect(BRIDGE_FAILURE_TEXT.companion_outdated).toContain("Try again");
    expect(BRIDGE_FAILURE_TEXT.companion_outdated).not.toContain("pnpm");
  });

  it("tells the user that Chrome updates an extension too old for the companion, and how to update it now", () => {
    expect(BRIDGE_FAILURE_TEXT.extension_outdated).toContain("This extension is too old");
    expect(BRIDGE_FAILURE_TEXT.extension_outdated).toContain("Chrome updates extensions on its own");
    expect(BRIDGE_FAILURE_TEXT.extension_outdated).toContain("chrome://extensions, turn on Developer mode and choose Update");
    expect(BRIDGE_FAILURE_TEXT.extension_outdated).not.toContain("companion package");
    expect(BRIDGE_FAILURE_TEXT.extension_outdated).not.toContain("pnpm");
  });

  it("points to Sign out before connecting with a different PAT", () => {
    expect(CONNECT_ERROR_TEXT.already_connected).toContain("Sign out");
  });

  it("asks for a new PAT when GitHub rejects the saved one", () => {
    expect(SAVED_TOKEN_REJECTED_TEXT).toContain("saved PAT");
    expect(SAVED_TOKEN_REJECTED_TEXT).toMatch(/paste a new PAT/i);
  });

  it("asks for a pasted PAT when the saved one is gone or unreadable", () => {
    expect(CONNECT_ERROR_TEXT.no_saved_token).toMatch(/paste a PAT/i);
    expect(CONNECT_ERROR_TEXT.keychain_read_failed).toContain("Try again");
    expect(CONNECT_ERROR_TEXT.keychain_read_failed).toContain("Sign out");
  });

  it("says the PAT is still in use but must be pasted again when saving fails", () => {
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("still connected");
    expect(CREDENTIAL_ERROR_TEXT.save_failed).toContain("next time");
  });

  it("names the Keychain Access item to delete when signing out cannot remove the PAT", () => {
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain("Keychain Access");
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain(HOST_NAME);
    expect(CREDENTIAL_ERROR_TEXT.forget_failed).toContain("Sign out");
  });
});
