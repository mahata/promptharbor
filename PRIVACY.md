# Prompt Harbor Privacy Policy

Last updated: October 21, 2026

Prompt Harbor is an independent, unofficial Chrome extension for chatting with GitHub Copilot
from Chrome's side panel, through a companion program on your Mac. It is not affiliated with,
sponsored by or endorsed by GitHub. This policy covers the extension and its companion.

## In short

- Prompt Harbor's developer runs no servers and receives none of your data. Prompt Harbor has
  no analytics, advertising or tracking of its own.
- The extension cannot reach the network. It talks only to the companion on your Mac, which
  sends your requests to GitHub through the GitHub Copilot CLI you installed.
- What goes to GitHub is what Prompt Harbor needs to chat with GitHub Copilot for you: your
  personal access token (PAT), your prompts, and the pages you choose to include.

## What Prompt Harbor handles, and why

- **Your fine-grained PAT**, when you choose **Connect**. The panel passes it to the companion
  through Chrome native messaging. The companion uses it to sign in to GitHub Copilot through
  the GitHub Copilot SDK and the GitHub Copilot CLI. Once GitHub accepts it, the companion saves
  it in your macOS login keychain. It is never stored in Chrome.
- **Your prompts and Copilot's replies**, when you send a prompt. Each prompt goes to GitHub
  Copilot with the conversation so far, so that Copilot can reply. The panel keeps the
  conversation only in memory. While the companion runs, the GitHub Copilot CLI also keeps a
  session log of your prompts and replies in a private temporary folder on your Mac, which the
  companion deletes when it stops. In checks with two versions of the CLI, it wrote none of
  them to the cache folder below.
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
  GitHub Copilot with that one prompt. The page then stays in the conversation.
- **Your GitHub username and the model you last chose**, once you are connected. The panel
  stores them in the extension's local storage in Chrome, so it can preselect that model the
  next time you connect with that account. They are not sent anywhere.

## Who receives it

- **GitHub.** Your PAT, prompts, included pages, the conversation so far and the model you
  chose go to GitHub, together with the request metadata and telemetry that the GitHub Copilot
  CLI sends, which can include that device identifier. The companion identifies itself to the
  CLI as `prompt-harbor`, which labels that telemetry, and neither configures nor suppresses
  it. GitHub handles this data under the
  [GitHub General Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)
  and the terms of your GitHub Copilot plan.
- **No one else.** Prompt Harbor's developer does not receive, sell or transfer your data, and
  does not use it for advertising or to determine creditworthiness or for lending.

## How long it is kept

- **Saved PAT:** in your macOS login keychain until you choose **Sign out**, or until you
  choose to delete it when you uninstall the companion.
- **Conversation:** in the panel's memory until you choose **New chat** or **Sign out**, or
  close the panel. The CLI's session log keeps it, including conversations you left with
  **New chat**, until the companion stops and deletes its temporary folder. If Chrome has to
  force-quit the companion, that folder (`$TMPDIR/prompt-harbor-*`) can remain until you
  delete it.
- **Copilot account details and device identifier:** in
  `~/Library/Caches/prompt-harbor/copilot-cli/` until you uninstall the companion or delete
  that folder. The CLI may refresh the account details when you connect, and keeps the device
  identifier, so it stays the same across connections.
- **Username and model choice:** in Chrome until you remove the extension.
- **What GitHub received:** as GitHub's policies say. Signing out, starting a new chat or
  closing the panel does not retract anything already sent.

## Your choices

- Leave **Include this page** unticked on pages that show private information. A page's URL
  can carry secrets such as session or password-reset tokens.
- **Sign out** deletes the saved PAT. You can also revoke the PAT on GitHub at any time.
- Uninstalling the companion removes it, its cache folder and, if you choose, the saved PAT.
  Removing the extension from Chrome removes what it stored in Chrome.

## Security

The saved PAT is encrypted at rest in your macOS login keychain. The extension passes the PAT,
your prompts and included pages only to the companion on your Mac, through Chrome native
messaging, and the GitHub Copilot CLI sends them to GitHub over HTTPS.

## Limited Use

Prompt Harbor's use of the information it handles adheres to the Chrome Web Store User Data
Policy, including the
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements.

## Changes and contact

Changes to this policy are made in this file, and the repository's history shows each one.
For questions, open an issue at <https://github.com/mahata/promptharbor/issues>.
