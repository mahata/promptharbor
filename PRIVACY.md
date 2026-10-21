# Prompt Harbor Privacy Policy

Last updated: October 21, 2026

Prompt Harbor is an independent, unofficial Chrome extension for chatting with GitHub Copilot
from Chrome's side panel, through a companion program on your Mac. It is not affiliated with,
sponsored by or endorsed by GitHub. This policy covers the extension and its companion. The
companion drives the GitHub Copilot CLI that you install yourself. The CLI is GitHub's software,
not part of Prompt Harbor, but this policy also says what the CLI keeps on your Mac when the
companion runs it.

## In short

- Prompt Harbor's developer runs no servers and receives none of your data. Prompt Harbor has
  no analytics, advertising or tracking of its own.
- The extension cannot reach the network. It talks only to the companion on your Mac, which
  sends your requests to GitHub through the GitHub Copilot CLI you installed.
- What goes to GitHub is what Prompt Harbor needs to chat with GitHub Copilot for you: your
  personal access token (PAT), your prompts, and the pages you choose to include. The GitHub
  Copilot CLI also sends GitHub its own telemetry.
- The companion always saves your PAT in your macOS login keychain until you sign out. Other
  programs running as your macOS user can read it there.
- On your Mac, the GitHub Copilot CLI keeps a log of your conversation until the companion
  stops, and your Copilot account details and a device identifier until you uninstall the
  companion. The sections below say what stays on your Mac, for how long, and how to delete
  it.

## What Prompt Harbor handles, and why

- **Your fine-grained PAT**, when you choose **Connect**. The panel passes it to the companion
  through Chrome native messaging. The companion uses it to sign in to GitHub Copilot through
  the GitHub Copilot SDK and the GitHub Copilot CLI. Once GitHub accepts it, the companion
  always saves it in your macOS login keychain, and signs in with it again each time you open
  the panel, until you sign out. There is no option to use a PAT without saving it. While
  connected, the companion and the GitHub Copilot CLI also hold it in memory. It is never
  stored in Chrome.
- **Your prompts and Copilot's replies**, when you send a prompt. Each prompt goes to GitHub
  Copilot with the conversation so far, so that Copilot can reply. The panel keeps the
  conversation only in memory. The GitHub Copilot CLI also writes a session log of your
  prompts and Copilot's replies, but not your PAT, into a private temporary folder
  (`$TMPDIR/prompt-harbor-*`) that the companion creates when it connects and deletes when it
  stops. **New chat** starts a new log in the same folder and leaves the earlier one there. In
  checks with two versions of the CLI, it wrote none of your prompts or replies to the cache
  folder below.
- **Your Copilot account details and a device identifier**, which the GitHub Copilot CLI keeps
  in the companion's cache folder, `~/Library/Caches/prompt-harbor/copilot-cli/`. The
  companion keeps that folder so the CLI need not unpack its program files again on every
  connection. When you connect, the CLI saves what GitHub reports about your Copilot account
  there, including your username, plan and entitlements, organization and enterprise
  memberships, quotas, feature settings and an analytics tracking ID. It also creates a
  random device identifier there, which it can send with its telemetry. Besides these, the
  folder holds the CLI's program files and lock files. This describes versions 1.0.92-4 and
  1.0.99-2 of the CLI, which is not part of Prompt Harbor; other versions may differ.
- **The page you are viewing**, only when you tick **Include this page** for a prompt. The
  panel reads the tab's title, URL, visible text and any text you selected, and sends them to
  GitHub Copilot with that one prompt. The page then stays in the conversation, and in the
  session log, like a prompt.
- **Your GitHub username and the model you last chose**, once you are connected. The panel
  stores them in the extension's local storage in Chrome, so it can preselect that model the
  next time you connect with that account. This stored copy is not sent anywhere.

## Who receives it

- **GitHub.** Your PAT, prompts, included pages, the conversation so far and the model you
  chose go to GitHub, together with the request metadata and telemetry that the GitHub Copilot
  CLI sends, which can include that device identifier. The companion identifies itself to the
  CLI as `prompt-harbor`, which labels that telemetry, and neither configures nor suppresses
  it. It runs the CLI with a temporary configuration of its own rather than your `~/.copilot`
  folder, so settings you made for the CLI yourself do not apply. GitHub handles this data
  under the
  [GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)
  and the terms of your GitHub Copilot plan.
- **No one else.** Prompt Harbor's developer does not receive, sell or transfer your data, and
  does not use it for advertising or to determine creditworthiness or for lending.

## How long it is kept

- **Saved PAT:** in your macOS login keychain until you choose **Sign out** or delete it
  yourself, or choose to delete it when you uninstall the companion.
- **Conversation in the panel:** in memory until you choose **New chat** or **Sign out**, or
  close the panel.
- **Session logs:** in the temporary folder, including those of conversations you left with
  **New chat**, until the companion stops, such as when you close the panel or choose
  **Sign out**. If Chrome has to force-quit the companion, the folder can remain until you
  delete it.
- **Copilot account details and device identifier:** in
  `~/Library/Caches/prompt-harbor/copilot-cli/` until you uninstall the companion or delete
  that folder. **Sign out** does not remove them. The CLI may refresh the account details when
  you connect, and keeps the device identifier, so it stays the same across connections.
- **Username and model choice:** in Chrome until you remove the extension.
- **What GitHub received:** as GitHub's policies say. Signing out, starting a new chat or
  closing the panel does not retract anything already sent.

## Deleting your data

- **Sign out** in the panel deletes the saved PAT and stops the companion, which deletes its
  temporary folder.
- To delete the saved PAT yourself, delete the `io.github.mahata.prompt_harbor` item in
  Keychain Access, or run:

  ```sh
  security delete-generic-password -s io.github.mahata.prompt_harbor -a fine-grained-pat login.keychain
  ```

- Uninstalling the companion removes it and its cache folder in
  `~/Library/Caches/prompt-harbor/`, and asks whether to delete the saved PAT too:

  ```sh
  "$HOME/Library/Application Support/prompt-harbor/companion/uninstall"
  ```

- To delete the Copilot account details and device identifier but keep the companion, delete
  `~/Library/Caches/prompt-harbor/copilot-cli/`. The next connection is slower while the CLI
  unpacks its program files again.
- Removing the extension in `chrome://extensions` deletes the username and model choice it
  stored.
- If Chrome force-quit the companion, delete any `prompt-harbor-*` folder it left in your
  temporary folder (`$TMPDIR`).
- Revoke the PAT on GitHub at any time. For what GitHub holds, see GitHub's privacy statement.

## Your choices

- Leave **Include this page** unticked on pages that show private information. A page's URL
  can carry secrets such as session or password-reset tokens.
- Use a PAT that expires soon and has only the Copilot Requests permission. Prompt Harbor
  always saves the PAT, so this limits what anyone who reads it can do, and for how long.
- Sign out when you are done, so that no PAT stays saved.

## Security

The saved PAT is encrypted at rest in your macOS login keychain. It is not protected from
other programs running as your macOS user, though. The companion saves it with macOS's
`security` command-line tool, which macOS then lets read the PAT without asking you, and any
of those programs can run that tool. While you are connected, they can also read the PAT
from the environment of the GitHub Copilot CLI that the companion runs. The extension passes
the PAT, your prompts and included pages only to the companion on your Mac, through Chrome
native messaging, and the GitHub Copilot CLI sends them to GitHub over HTTPS.

## Limited Use

Prompt Harbor's use of the information it handles adheres to the Chrome Web Store User Data
Policy, including the
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements.

## Changes and contact

This policy is kept in the Prompt Harbor repository as
[PRIVACY.md](https://github.com/mahata/promptharbor/blob/main/PRIVACY.md), and
[its history](https://github.com/mahata/promptharbor/commits/main/PRIVACY.md) shows every
change. It is published at <https://mahata.github.io/promptharbor/privacy/>.

For questions about privacy, open an issue at <https://github.com/mahata/promptharbor/issues>.
Issues are public, so do not put your PAT or other private information in one.
