# Prompt Harbor

Prompt Harbor is an independent, unofficial Chrome side-panel client for chatting with
GitHub Copilot through the official [Copilot SDK](https://github.com/github/copilot-sdk),
which runs in a small companion process on your Mac. It is not affiliated with, sponsored
by or endorsed by GitHub.

**Current status:** the chat panel, the companion, its macOS Keychain storage for your PAT
and its installer package are built and tested against a scripted fake companion. The
companion builds into a self-contained executable for Apple silicon or Intel Macs, and into
an installer package that installs it for your macOS user, after which it runs without
pnpm or this checkout. It carries Node.js but no Copilot runtime: it drives the
[GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) you install
yourself, so you must install that too. A [live check](#live-check) with a
real fine-grained PAT has also verified authentication, model listing and multipliers,
usage reporting, page access after a toolbar click, denied page access after a
cross-origin navigation, authentication failure and sign-out, but with an earlier
companion that ran from this checkout on Node.js and carried its own runtime. It has yet to
be repeated with the self-contained build. The package is not signed or notarized yet, so
it is for testing only.

## Why a local companion

The first version called GitHub's undocumented token exchange,
`https://api.github.com/copilot_internal/v2/token`, directly from the extension. A
fine-grained PAT got **HTTP 404**. Clients that use that endpoint exchange tokens from
Copilot's editor OAuth apps. Getting past it would have meant borrowing those app IDs or
impersonating an editor, which the experiment's stop rule forbids. The direct flow is
therefore gone.

The SDK
[supports fine-grained PATs](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md),
so the experiment now uses that route instead:

```mermaid
flowchart LR
  Panel["Side panel<br/>(no network access)"] -- "Chrome native messaging<br/>(stdio, JSON)" --> Companion["Companion<br/>(self-contained executable<br/>on this Mac)"]
  Companion -- "/usr/bin/security" --> Keychain["macOS login keychain<br/>(saved PAT)"]
  Companion -- "Copilot SDK" --> Cli["GitHub Copilot CLI<br/>(you install it)"]
  Cli -- HTTPS --> GitHub["GitHub Copilot"]
```

- The extension cannot reach the network. It has no host permissions, and its CSP sets
  `connect-src 'none'`. It can talk only to the companion.
- It reads a web page only when you tick **Include this page** for a prompt, and only in a
  tab Chrome has granted it through `activeTab`, by your clicking its toolbar icon there.
- Chrome starts the companion when the panel opens, so the panel can tell whether it is
  installed and whether a PAT is saved. With a saved PAT, the panel connects right away.
  Otherwise nothing is sent to GitHub until you choose **Connect**.
- The companion lives only as long as the panel's connection. Closing the panel ends it,
  along with its in-memory PAT and SDK session. **Sign out** deletes the saved PAT, ends the
  companion and starts a fresh one that asks for a PAT. A saved PAT stays in your login
  keychain until you sign out, or until you choose to delete it when you uninstall the
  companion.
- The companion carries no Copilot runtime. The SDK starts the
  [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) already on your
  Mac, which is what talks to GitHub. The companion looks for it as it starts and tells the
  panel what it found, so a CLI that is absent, or a program that is not the Copilot CLI at
  all, is explained before you paste a PAT. Whether a real Copilot CLI is compatible is
  settled by the SDK's protocol handshake, which happens when you connect, so an
  incompatible one is reported then rather than at startup.

The companion process itself cannot be dropped, even though it now carries no runtime.
Chrome gives an extension exactly one way to reach a local program: a native messaging host
registered in a manifest Chrome reads, speaking Chrome's own framing of a 4-byte
little-endian length prefix and UTF-8 JSON, with the extension's origin passed as its first
argument. The Copilot CLI does not speak that, and its `--acp` mode is a different protocol.

## Requirements

- macOS 13.5 or later, on Apple silicon or Intel, with Google Chrome 120 or later. The
  installer registers the companion with Google Chrome only, not with Chromium or other
  Chrome channels.
- A GitHub account with Copilot access, and permission to create a fine-grained PAT for
  it.
- The [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), which the
  companion drives through the SDK. Install it with
  `brew install --cask copilot-cli`, or however its documentation suggests. You do not need
  to run `copilot login`: the companion authenticates with the PAT you give the panel, and
  never uses a session you signed in elsewhere. The companion looks for it in your `PATH`
  and in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and `~/.npm-global/bin`,
  because Chrome starts the companion with only `/usr/bin:/bin:/usr/sbin:/sbin`. The
  installer records where it found one, and `COPILOT_CLI_PATH` pins a particular one.
- To build the companion or its package from this checkout: Node.js 26 and pnpm 10.33.0,
  on a Mac with the same architecture as the one that will run the companion. Install
  pnpm separately. The installed companion needs neither. To build a package that others
  may install, use a Node.js that keeps its `LICENSE` beside `bin/`, as the nodejs.org
  tarballs, nvm, fnm, Homebrew and `actions/setup-node` do. With another Node.js, such as
  the nodejs.org installer package, `THIRD-PARTY-NOTICES.txt` only links to Node.js's
  license, and the build warns not to distribute it.

## Install

First install the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli),
which the companion drives:

```sh
brew install --cask copilot-cli
```

The companion itself comes as an installer package for each kind of Mac:
`prompt-harbor-companion-<version>-macos-arm64.pkg` for Apple silicon and
`prompt-harbor-companion-<version>-macos-x64.pkg` for Intel, because it carries a Node.js
binary built for one of them. **About This Mac** says which kind yours is. There is no
release yet, so build the package on a Mac of the same kind, or download it from the
`companion-darwin-arm64` or `companion-darwin-x64` artifact of a CI run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm companion:package
```

`pnpm companion:package` builds the companion for this Mac's architecture into
`dist-companion/darwin-arm64/` or `dist-companion/darwin-x64/`, then packages that build
as, for example, `dist-companion/prompt-harbor-companion-0.1.0-macos-arm64.pkg`. Open the
package and follow Installer's steps, or install it from Terminal:

```sh
installer -pkg dist-companion/prompt-harbor-companion-0.1.0-macos-arm64.pkg -target CurrentUserHomeDirectory
```

The package is not signed or notarized yet, so macOS cannot tell who built it. Installer
opens a package you built, but macOS refuses to open one downloaded through a browser,
such as a CI artifact. Install only a package built from this repository, and install a
downloaded one with the `installer` command above, which does not ask Gatekeeper.

In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**,
and select this checkout's `dist/` directory. The manifest's `key` pins the extension ID
to `hdmfkhdfamhcfglofebjnoepkbbbihkg`, and the companion accepts only that ID. Open the
extension from the toolbar, or press Ctrl+Shift+H on Windows/Linux or ⌘+Shift+H on
macOS. It should ask for a fine-grained PAT. If it shows an error instead, the error
names the fix, including when it cannot find the GitHub Copilot CLI.

### What the package installs

The package installs for your macOS user only, so it needs no administrator password. It
refuses to install on a Mac of the other kind, or on a macOS version older than the
companion was built for (macOS 13.5 with Node.js 26). It has no payload of its own: its
postinstall script has the companion that the package carries install itself, so macOS
keeps no package receipt, and `pkgutil --pkgs` does not list it. The companion installs:

- `~/Library/Application Support/prompt-harbor/companion/`: the companion, about 140 MB.
  - `prompt-harbor-companion` is a Node.js
    [single executable application](https://nodejs.org/api/single-executable-applications.html)
    holding Node.js 26 and the bundled companion code, signed ad hoc. Nearly all of the
    140 MB is the Node.js binary.
  - `uninstall` removes the companion, as described [below](#uninstall).
  - `LICENSE.txt` is this project's license. `THIRD-PARTY-NOTICES.txt` gives the license
    of Node.js and of the packages bundled into the executable. Node.js is MIT-licensed
    and explicitly allows redistribution, and its `LICENSE`, which also covers the
    libraries built into the binary, is included in full.
- `~/Library/Application Support/prompt-harbor/config.json`: where the installer found the
  GitHub Copilot CLI, so the companion need not search for it on every start. The
  companion only reads it, and searches again by itself when the recorded path has gone.
  Delete the file to have the next install look again.
- `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.mahata.prompt_harbor.json`:
  registers `prompt-harbor-companion` with Chrome for this extension only. It takes the
  extension ID from `src/protocol/identity.ts`, which the companion checks too and a test
  ties to the manifest's `key`.

The companion also creates `~/Library/Caches/prompt-harbor/copilot-cli/`, the only thing it
writes while it runs. The GitHub Copilot CLI unpacks its runtime into whatever `HOME` it is
given, about 138 MB, so the companion gives it this directory: without a stable one it would
do that again on every connection. Uninstalling removes it, and deleting it yourself only
costs one slower connection.

The package carries no GitHub Copilot software, so there is nothing of GitHub's to
redistribute. It drives the Copilot CLI you installed.

The installed copy does not use the package, this checkout, a separate Node.js or pnpm, so
deleting them does not break it. It does need the GitHub Copilot CLI to stay installed.

### Update

Install a newer package over the installed one. It replaces the earlier install only once
the new one is complete: it copies the new companion beside the old one and writes the
new host manifest beside the old one, then swaps each into place by renaming. If the
host manifest cannot take the old one's place, it puts the earlier companion back. So a
failed install leaves the earlier companion working, and a failed first install leaves
nothing behind. If an install is interrupted, the next one first puts back the companion
it had moved aside. It also replaces the launcher that earlier development versions
installed. Updating keeps a saved PAT. A companion that is running keeps running the
earlier version, so close any open Prompt Harbor side panel and open it again.

### Uninstall

Run the uninstall script in Terminal:

```sh
"$HOME/Library/Application Support/prompt-harbor/companion/uninstall"
```

It removes the companion, its recorded Copilot CLI path, its Copilot CLI cache and its
Chrome host manifest. If your login keychain holds a
saved PAT, it first asks whether to delete that too, and keeps it unless you answer `y`.
It keeps it without asking when it cannot ask, such as when no terminal is attached, and
`--keep-saved-pat` or `--delete-saved-pat` decides without asking. When it keeps a saved
PAT, it prints the command that deletes it:

```sh
security delete-generic-password -s io.github.mahata.prompt_harbor -a fine-grained-pat login.keychain
```

**Sign out** in the panel also deletes the saved PAT. Then remove the extension in
`chrome://extensions`.

### From a checkout

`pnpm companion:install` builds the companion and installs it the same way, without a
package, which includes writing `config.json` with the GitHub Copilot CLI it found. It
overwrites an earlier record only when it finds one, so a stale record survives an install
that finds nothing. `pnpm companion:uninstall` uninstalls like the uninstall script, with
the same question and options, such as `pnpm companion:uninstall --delete-saved-pat`, and
removes `config.json` and the Copilot CLI cache.

Older development builds used different install and Keychain identifiers. Prompt Harbor
does not migrate or remove those entries.

## Use

- **Open:** click the toolbar icon, or press Ctrl+Shift+H on Windows/Linux or ⌘+Shift+H
  on macOS. Change the shortcut from `chrome://extensions/shortcuts`.
- **Sign in:** the first time, the panel shows only a PAT field. Paste a fine-grained PAT
  and choose **Connect**. Once GitHub accepts it, the companion saves it in your macOS
  login keychain, and from then on the panel opens straight into the chat. **Sign out**
  deletes the saved PAT and asks for a new one.
- **Chat:** write a prompt of up to 32,768 characters and choose **Send**, or press Enter,
  ⌘ Enter or Ctrl Enter. Shift Enter starts a new line. While an input method is composing,
  such as when converting to kanji, Enter only confirms the conversion. The menu next to
  **Send** restores the model you last selected for that GitHub account when it remains
  available; otherwise, it preselects the model with the lowest billing multiplier. Each
  option ends with the multiplier the SDK reported, such as "(1×)".
- **Replies:** they stream in and render as Markdown (headings, lists, code blocks,
  tables, links), and the conversation follows them while you are scrolled to its end.
  Links open in a new tab; only `http`, `https` and `mailto` links are clickable, and
  images appear as links because the panel loads no remote content. While a reply streams, **Stop** replaces **Send**. It ends the
  reply early and keeps what arrived. You can draft the next prompt meanwhile.
- **Pages:** tick **Include this page** before sending to have Copilot read the tab you are
  viewing. The panel reads the page's title, URL, visible text and any text you selected,
  and sends them with that one prompt. The box clears after each send. Chrome lets the
  extension read a tab only after you open it from the toolbar or shortcut while that tab
  is open, and only until the tab closes or navigates to a different site (origin). Pages
  on the same origin stay readable after a navigation. If the panel cannot read the tab,
  it sends nothing and says why:
  - `page_access_needed`: Chrome has not granted this tab. Open the extension from the
    toolbar or shortcut on it and send again. `file://` pages also need **Allow access to
    file URLs** in `chrome://extensions`.
  - `page_restricted`: Chrome never allows reading `chrome://` pages, the New Tab page, the
    Chrome Web Store, other extensions or sites blocked by policy.
  - `page_error_page`: the tab shows an error page. Reload it.
  - `page_unreadable`: anything else, with Chrome's own reason when it gave one.
  - `page_timeout`: the page did not answer within 5 seconds. Up to
  100,000 characters of text and 32,768 of selection are sent, and a note tells Copilot when
  the page was cut short. The page stays in the conversation, so a few large pages can lead
  to `context_limit` sooner.
- **Conversations:** the conversation carries across prompts, including when you switch
  models. **New chat** starts over, and Copilot no longer sees the earlier messages. If a
  conversation outgrows the model's context window, a reply can fail with
  `context_limit`. Start a new chat when that happens.

## Live check

The live check has passed with a real PAT, but against the earlier companion that ran on
Node.js from this checkout. Repeat it with a companion installed as described in
[Install](#install). It covers authentication, model listing and
multipliers, usage reporting, conversation behavior, page access and denial, persistence,
and sign-out. Keep it as a manual release check because the test suite never uses a real
credential or sends live Copilot requests. Never put a credential in chat, issues, commits,
screenshots, logs or CI.

1. Create a fresh, expiring
   [fine-grained PAT](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
   with your personal account as resource owner and only the **Copilot Requests** account
   permission.
2. Paste it into the PAT field and choose **Connect**. The companion starts the SDK, which
   checks the PAT with GitHub and lists models. No prompt is sent. Once GitHub accepts the
   PAT, the panel switches to the chat, and the companion saves the PAT in your macOS
   login keychain.
3. Check that the Keychain item exists. This command prints its attributes but not the PAT:

   ```sh
   security find-generic-password -s io.github.mahata.prompt_harbor -a fine-grained-pat login.keychain
   ```

4. Send a short prompt, then a follow-up that depends on the reply. Switch models, send
   another follow-up, and check that the conversation carries over. Every prompt is a live
   request that uses your Copilot allowance, and nothing is retried automatically.
5. Choose **New chat** and check that Copilot no longer sees the earlier messages. Then ask
   for a long answer and choose **Stop** while it streams. The partial reply should stay,
   marked "Stopped. Output may be incomplete."
6. Open an ordinary web page, click the toolbar icon on it, tick **Include this page** and
   ask for a summary. The reply should reflect the page. Then follow a link on that page
   to a different site, tick the box again and send: the panel should report
   `page_access_needed` and send nothing until you click the toolbar icon again. Clicking
   the icon while the panel is open should grant access and leave the panel open.
7. Close the panel and open it again. It should open straight into the chat, connected
   with the saved PAT.
8. Record any error codes, the Chrome version, the architecture and SDK version that
   `pnpm companion:package` or `pnpm companion:install` printed when it built the
   companion, and the model names and
   multipliers in the model menu. Check usage in your GitHub account. Do not record
   tokens, raw server responses or headers.
9. Choose **Sign out** and run the command from step 3 again. It should report that the
   item could not be found, and the panel should ask for a PAT again. Close the panel and
   revoke the PAT.

If something fails:

- **`auth_failed`:** GitHub did not accept the PAT. Check its owner, permission and
  expiry. If a correct PAT still fails, record the result and stop.
- **No enabled models:** the panel offers only models whose SDK metadata says
  `policy.state: "enabled"`, and it does not guess when that field is missing. Record the
  result and stop, because the filter may need revisiting.
- **`runtime_not_found`:** the companion found no GitHub Copilot CLI. Install it, then
  choose **Try again**, which restarts the companion so it looks again.
- **`runtime_unsupported`:** the Copilot CLI and the SDK could not agree a protocol version,
  so the CLI is too old or too new for the SDK this companion was built with. Run
  `copilot update`, then choose **Try again**.
- **`sdk_start_failed`:** the companion found a Copilot CLI but could not start it. Record
  the CLI's version with `copilot --version` and stop.
- **`keychain_read_failed`, `save_failed` or `forget_failed`:** `/usr/bin/security` could
  not read, save or delete the saved PAT. The error says what still works. Record the
  result, and delete any leftover item in Keychain Access.
- **`companion_*` codes:** the panel names the fix. Most need the package installed again,
  followed by **Try again**.
- **`missing` or `unsupported` before you paste a PAT:** what the companion found when it
  started. `missing` is no Copilot CLI at all; `unsupported` is a program that does not
  identify itself as one. The panel explains either without taking a PAT it could not use,
  and **Sign out** still works, so a saved PAT can be deleted. A Copilot CLI that is merely
  the wrong version passes this check and fails later, as `runtime_unsupported` above.

Stop when GitHub denies access. Do not work around a denial with a stored login, a `gh`
token, a classic PAT, a borrowed OAuth app ID, editor impersonation or a custom
integration ID. A passing check shows technical access through the SDK for your own
account. It does not mean approval to distribute this or to offer it to other people.

## Boundaries

The extension:

- Requests only `sidePanel`, `nativeMessaging`, `activeTab` and `scripting`. It has no host
  permissions and no content scripts. `activeTab` gives it access only to a tab where you
  invoked the extension from the toolbar or shortcut, until that tab closes or navigates
  to another origin (same-origin navigation keeps it), and Chrome shows no install-time
  warning for it.
- Runs a script in a tab only when you send a prompt with **Include this page** ticked. The
  script runs in the tab's top frame, reads `document.title`, `location.href`, the body's
  `innerText` and the current selection, and returns them. It does not read form values,
  cookies, storage or other frames, and it changes nothing on the page. The panel gives up
  after 5 seconds and then sends nothing.
- Sends the companion a PAT only if it starts with `github_pat_`, and clears the field on
  submission. It stores only the last selected model identifier for each GitHub account in
  extension-local browser storage. The companion stores accepted PATs in the macOS login
  keychain; available models and the conversation live only in the panel's memory.
- Sends only the prompts you submit, exactly as typed, and refuses any over 32,768
  characters. It attaches page content only as described above, and never files.
- Renders prompts as plain text. Renders responses as Markdown by building DOM nodes from
  [marked](https://marked.js.org/)'s tokens, never through `innerHTML`, so raw HTML in a
  response shows as literal text. Errors show fixed text and a code,
  never the server's text or the token.

The companion:

- Runs as a Node.js single executable application that ignores `NODE_OPTIONS`, so the
  environment Chrome starts it with cannot load other code into it. It starts the GitHub
  Copilot CLI it located, and nothing else.
- Talks to Chrome only when its first argument is this extension's origin, which Chrome
  passes when this extension starts it. Chrome's host manifest also allows only this
  extension ID. Given `--install <home folder>`, as the package's postinstall script does,
  or `--uninstall`, as its uninstall script does, it installs or uninstalls itself instead.
  Otherwise it exits.
- Accepts six messages: connect with a PAT, optionally remembering it; connect with the
  saved PAT; send a prompt of at most 32,768 characters to a model from this connection's
  list, optionally with a page of at most 4,096 characters of URL, 1,000 of title, 100,000
  of text and 32,768 of selection; stop; start a new chat; and forget the saved PAT.
- Keeps a saved PAT as a generic password item in your login keychain, with service
  `io.github.mahata.prompt_harbor` and account `fine-grained-pat`:
  - It names the login keychain (`login.keychain`) in every `security` command, so a
    different default keychain or search list does not change where it saves, reads or
    deletes the PAT.
  - It saves a pasted PAT once GitHub has accepted it, replacing any earlier one. The
    panel always asks it to. A forget request that arrives before GitHub accepts the PAT
    cancels that save, so the last request wins.
  - At startup it checks only whether the item exists. It reads the PAT only to connect
    with it, and uses it only if it is still a well-formed fine-grained PAT.
  - It deletes the item on **Sign out**. Uninstalling the companion deletes it only if you
    choose to.
  - It runs `/usr/bin/security` with only `HOME` and a system `PATH`, and stops it after
    10 seconds. The PAT goes in on standard input rather than as an argument, the tool's
    error output is discarded, and the PAT is never logged.
- Looks for the GitHub Copilot CLI as it starts, and tells the panel in its greeting whether
  it is `ready`, `missing` or `unsupported`, with the version it read. It prefers the path
  `config.json` records, checks that it still exists, and otherwise searches `PATH` and the
  usual install directories. `COPILOT_CLI_PATH` pins one instead, and is authoritative: if
  the path it names is not there, the companion reports `missing` rather than quietly
  running a different Copilot CLI. A `missing` result is looked up again when you connect,
  so installing the CLI and choosing **Try again** is enough.
- Runs `copilot --version` to read the version, stopping it after 30 seconds, and treats
  anything that does not answer like the Copilot CLI as unsupported. It accepts the version
  banner only as a whole line, so a program whose output merely mentions the Copilot CLI
  cannot pass as one. The limit is that
  generous because the first run in a home folder the Copilot CLI has not used unpacks its
  runtime, about 138 MB, before printing anything; a shorter one would kill a working CLI
  mid-unpack and report it as not the Copilot CLI. It applies no version
  floor of its own. The SDK negotiates a protocol version with the CLI when it starts it,
  and refuses one it cannot speak in either direction, so that handshake decides
  compatibility and reports `runtime_unsupported`. An earlier version of this companion did
  guess a floor from the version the SDK bundles, which rejected the Copilot CLI that
  Homebrew installs.
- Configures the SDK:
  - `mode: "empty"` and `useLoggedInUser: false`, which stop the runtime from using stored
    OAuth tokens or `gh` CLI authentication and turn off the SDK's other ambient features.
    The runtime authenticates only with the PAT the companion passes as `gitHubToken`.
  - No tools (`availableTools: []`), and every permission request is rejected.
  - One streaming session per conversation, kept across prompts and switched with
    `setModel` when you change models. **New chat** disconnects it, and the next prompt
    starts a fresh one. Infinite sessions are off, which turns off the SDK's background
    compaction and session workspace, so an overlong conversation can fail with
    `context_limit`. Sub-agent events are ignored.
- Gives the Copilot CLI a new private temporary directory as its `TMPDIR`, Copilot home
  (`COPILOT_HOME`) and working directory, instead of your `~/.copilot` configuration, and
  `~/Library/Caches/prompt-harbor/copilot-cli/` as its `HOME`, so it unpacks its runtime
  once rather than on every connection and still never reads your own home folder. The rest
  of its environment is a system `PATH` and the variables the SDK adds, so tokens such as
  `GH_TOKEN` are not passed on. Neither are proxy and custom CA settings such as
  `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS`, so networks that require them will not work.
- Puts an attached page ahead of your prompt, between markers, with an instruction to treat
  it as data rather than instructions.
- Enforces limits: 1 MiB per inbound message, 1 MiB per outbound message (Chrome's
  limit), 32,768 characters per prompt, 65,536 characters per reply, 60 seconds per
  connect, 5 minutes per reply, and one connect or prompt at a time. The reply length and
  time limits end a reply with an explicit error and keep what arrived.
- Counts an operation as running until it has cleaned up, and reports its error only then.
  A failed or timed-out connection waits for its runtime to stop. A reply ended by a limit
  waits for its turn to end. If the turn has not ended 5 seconds after the abort, the
  companion reports the limit, stops the runtime and exits, and the panel offers **Try
  again**.
- Handles **Stop** by aborting the current turn and keeping the partial output, marked
  incomplete. It may not prevent server-side work or charges. Stop replaces the reply's
  5-minute limit with 5 seconds: if the turn has not ended by then, the companion reports
  it stopped, stops the runtime and exits, and the panel offers **Try again**.
- Stops a runtime by asking it to shut down, killing it if it has not stopped within
  5 seconds, and then deleting its temporary directory. It does this after a failed
  connection and on exit.

Accepted risks:

- An included page goes to GitHub as part of the conversation, including its full URL.
  URLs can carry secrets such as session or reset tokens in their query strings, and the
  visible text can include private information shown on the page. Leave **Include this
  page** unticked on such pages.
- Page text can contain instructions aimed at the model (prompt injection). The companion
  tells the model to treat the page as data, but a model may still follow it and give a
  misleading answer. The session has no tools and rejects every permission request, so the
  page cannot make Copilot act on anything.

- A saved PAT is encrypted at rest in your login keychain, never in Chrome's profile. But
  macOS trusts the tool that created an item to read it without warning. The companion
  saves the PAT with `/usr/bin/security`, so any process running as your macOS user can
  read it by running that tool. Use an expiring PAT and sign out when you are done.
- The panel saves every PAT that GitHub accepts. There is no way to keep a PAT only in
  memory.
- While a PAT is saved, the panel connects with it every time it opens, which sends it to
  GitHub through the SDK.
- While connected, the PAT sits in the companion's memory and in the runtime's
  `COPILOT_SDK_AUTH_TOKEN` environment variable. Other processes running as your macOS user
  can read it there. Use a short-lived PAT and close the panel when you are done.
- Because the manifest's public `key` fixes the ID, any unpacked extension with the same key
  can talk to the companion, including connecting with the saved PAT and sending prompts.
  The companion never sends the PAT back. Loading such an extension requires access to
  your Chrome profile.
- While the companion runs, the runtime's session log in its temporary directory holds your
  prompts and replies, but not the token. If the companion is still running a few seconds
  after the panel disconnects, Chrome force-quits it, and that directory
  (`$TMPDIR/prompt-harbor-*`) can then remain. Delete leftovers by hand.
- The runtime keeps its default integration ID, `copilot-developer-cli`. The companion only
  names itself `prompt-harbor` in the SDK's `clientInfo`, which labels the runtime's
  telemetry.
- The companion is signed ad hoc, not with a Developer ID, and neither it nor its package
  is notarized, so macOS cannot tell who built them. It also lives in a folder your macOS
  user can write to. Install only a package built from this repository, by you or by its
  CI.
- The SDK is young (1.0.x), so its options, defaults and events may change, including the
  ones this lockdown relies on. `pnpm install --frozen-lockfile` installs the exact version
  pinned in `pnpm-lock.yaml`, `pnpm list @github/copilot-sdk` names it, and the companion
  build carries that version. After updating the SDK, review
  `src/companion/sdk-gateway.ts`, including the protocol-mismatch message it matches to
  report `runtime_unsupported`, then run `pnpm check`, install a new package and repeat
  the live check.
- The Copilot CLI is no longer pinned by this project: it is whatever is installed on your
  Mac, and it updates itself. The SDK's protocol handshake catches a CLI that is too old or
  too new, but only when you connect, not when the panel opens. Its own behaviour within a
  compatible protocol version is not pinned at all.
- `COPILOT_CLI_PATH` makes the companion start whatever executable it names. Anyone who can
  set it in Chrome's environment, or write `config.json`, chooses the program the companion
  runs. Both need access to your macOS user account, which can already run that program
  directly.

GitHub receives the PAT, your prompts, any pages you include and the conversation so far with the SDK's system
instructions, the chosen model, and whatever request metadata and telemetry the official
runtime sends. This project neither configures nor suppresses that telemetry.
Signing out, starting a new chat or closing the panel does not retract anything already
sent.

## Development

```sh
pnpm test
pnpm exec playwright install chromium
pnpm check
```

`pnpm check` runs the unit tests, the companion tests, strict TypeScript checking, a
production build and the browser tests. It needs macOS, because the companion builds only
there, for the Mac that builds it. `pnpm test:companion` also needs the GitHub Copilot CLI
installed, because the companion drives it rather than a runtime of its own; the tests say
so and stop if it is missing. Each test gives the companion its own home folder, so each one
has the Copilot CLI unpack its runtime again, which is most of why the suite takes minutes.
It builds the companion into `dist-companion/` and checks
that build and a package made from it:

- It is a signed executable for this Mac's architecture that refuses to start unless Chrome
  starts it for the extension, and ignores `NODE_OPTIONS`.
- It greets Chrome with the SDK version it was built with and the Copilot CLI it found, in
  an environment with no `PATH`, so without a separate Node.js, and puts nothing in the home
  folder it was given but the Copilot CLI's cache.
- It carries its uninstall script, this project's license and the third-party notices, and
  no Copilot runtime package.
- A copy of it elsewhere connects through its own bundled SDK and the Copilot CLI on this
  Mac. The check sends a fake PAT from inside a `sandbox-exec` sandbox that denies network
  connections, so the PAT never leaves the Mac, and expects `auth_failed` with the
  runtime's temporary directory already removed. It first checks that the sandbox really
  blocks a connection.
- It installs itself into a temporary home folder and uninstalls through its uninstall
  script there. The installer command does the same with a copy.
- The package installs only for the current user and carries the build unchanged.
  Installed with `installer` into a temporary home folder, it installs a companion that
  starts, replaces an earlier install completely, fails without touching the earlier
  install when the new one cannot be put in place, refuses Macs of the other kind and
  older macOS versions before running anything, and installs an uninstall script that
  removes everything. `installer` installs into the folder that `CFFIXED_USER_HOME` names,
  and the tests first install a probe package that only records where it would install,
  so they stop before installing into your own home folder if that ever changes.

The browser tests:

- Use the real installer to register a scripted fake companion in a throwaway Chromium
  profile.
- Load the built extension and drive every panel state, including the first-run PAT
  prompt, a missing companion, a missing Copilot CLI and a program that is not one,
  rejected tokens, no models, saving, reusing, replacing and
  unreadable saved PATs, signing out, multi-turn chat, model switches, New chat, including
  a page (with Chrome's scripting stubbed, because a test cannot click the toolbar icon to
  grant `activeTab`) and refusing to when access is missing, keyboard
  shortcuts and input methods, the prompt length limit, following a streaming reply, Stop,
  failures, a crash mid-reply, closing the panel, permissions and layout.
- Run the real protocol code in the fake companion, which never loads the SDK and keeps
  its saved PAT in a temporary file instead of the Keychain.
- Block and record every HTTP request the browser makes, and assert that the install,
  chat, saved-PAT and permission flows make none.

No real PAT or Copilot allowance is used, so the tests do not establish live compatibility
or billing. They never touch your login keychain either. Tests that run the real
`/usr/bin/security`, directly or through the real companion or installer, give it a
temporary `HOME`, where it finds no login keychain. The other tests use fakes.

CI runs the same checks for pull requests, pushes to `main`, and on demand from the
Actions tab. Unit tests, the type-checked build and the browser tests run on Ubuntu, where
Chromium also reads the profile's `NativeMessagingHosts` directory. Unit tests and the
type-checked build run in parallel. The E2E job then tests the exact `chrome-extension`
artifact uploaded by the build, which you can also download from the run and load unpacked
in place of `dist/`. The companion still comes from a package or `pnpm companion:install`
built from the same commit. Playwright output, including layout screenshots, is uploaded as
`playwright-test-results` even when tests fail. The companion jobs install the GitHub
Copilot CLI with Homebrew and run `pnpm test:companion` natively on `macos-latest` (Apple
silicon) and `macos-15-intel` (Intel), then package each build and upload the package as
`companion-darwin-arm64` or
`companion-darwin-x64`. Those packages are not signed or notarized, and the companion in
them is signed ad hoc, so they are for testing only. CI uses no secrets and has read-only
repository access.

The code is organized as:

- `src/sidepanel/`: the chat panel UI, its native messaging bridge and page capture.
- `src/companion/`: the companion's entry point, protocol state machine, SDK gateway,
  Keychain store, frame codec, page prompt, Copilot CLI lookup, version check, recorded
  configuration, build, license notices, install layout, installer and installer package.
- `src/protocol/`: the messages and extension identity shared by both sides.

## Evidence

- [SDK authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md):
  `github_pat_` fine-grained PATs are supported, and classic `ghp_` tokens are not.
- [Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli):
  the PAT must be owned by your personal account and have the Copilot Requests permission.
- [SDK multi-tenancy](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md):
  `mode: "empty"` and the default integration ID.
- The SDK's own `CopilotClient` documentation gives
  `RuntimeConnection.forStdio({ path: "/usr/local/bin/copilot" })` as the way to use a
  Copilot CLI of your own, and the SDK starts whatever it is given with the CLI's
  `--headless --no-auto-update --stdio` flags, saying "Path to Copilot CLI is required"
  when it has none. Checked against `@github/copilot-sdk` 1.0.14 in
  `node_modules/@github/copilot-sdk/dist/client.js`.
- Checked here: the SDK drives an installed Copilot CLI. Against
  `/opt/homebrew/bin/copilot` 1.0.89-3, `start()` succeeded, `getAuthStatus()` returned
  `{"isAuthenticated":false,...}` for a deliberately invalid PAT, and `listModels()` failed
  only on that PAT.
- The SDK checks Copilot CLI compatibility by negotiating a protocol version when it starts
  one: `client.js` accepts protocol versions `MIN_PROTOCOL_VERSION` (3) through
  `getSdkProtocolVersion()` and throws "SDK protocol version mismatch" otherwise. Its
  `COPILOT_CLI_VERSION` constant (1.0.85) is only the version it unpacks for its own bundled
  runtime, which this project no longer uses, so it is not a compatibility floor. Treating it
  as one rejected Copilot CLI 1.0.83, which is what `brew install --cask copilot-cli`
  installed in CI.
- Node.js is MIT-licensed and its `LICENSE`, which also covers the libraries built into the
  binary, grants the right to distribute. That is what makes shipping it inside the
  companion executable allowed, and the build includes that file in
  `THIRD-PARTY-NOTICES.txt`.
- [SDK streaming events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
  and [usage and billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md):
  `assistant.message_delta`, `session.idle` and the `assistant.usage` multiplier.
- [`activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) and
  [`chrome.scripting`](https://developer.chrome.com/docs/extensions/reference/api/scripting):
  temporary access to the tab where the user invoked the extension, kept across same-origin navigation and ended by
  navigating to another origin or closing the tab.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  and [the manifest `key`](https://developer.chrome.com/docs/extensions/reference/manifest/key).
- `man security`, under `add-generic-password`: `-U` replaces an existing item, and by
  default the application that creates an item is trusted to read it without warning. The
  add, find and delete commands also take a keychain argument, and the page's examples name
  the login keychain `login.keychain`.
