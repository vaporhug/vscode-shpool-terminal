# Shpool Persistent Terminal

[中文说明](README.zh-CN.md)

A small Linux workspace extension that adds **Shpool Persistent** to VS Code's native terminal profile menu. shpool is the direct backing process. It starts a normal persistent shell; it never starts Codex or any other application.

## Install and use

1. Use **VS Code 1.121 or newer** with a **Linux x64** server. The VSIX includes checksum-pinned **shpool 0.11.4**; no separate shpool or Rust installation is needed. Linux `util-linux` (`/usr/bin/flock`) and `/bin/cat` are required for the workspace ownership lock.
2. Connect with VS Code Desktop's **Remote-SSH** extension. Run **Extensions: Install from VSIX…** and select `vscode-shpool-terminal-0.2.0-linux-x64.vsix`. Ensure it is installed/enabled under **SSH: your-server**, not only locally. **Developer: Show Running Extensions** should report it in the remote workspace host.
3. Open a trusted workspace. Choose **Terminal → New Terminal dropdown → Shpool Persistent**.

For `ResearchClawBench`, terminals and shpool sessions are named `ResearchClawBench-1`, `ResearchClawBench-2`, etc. Native bash/zsh profiles and your default profile are untouched. Type whatever commands you want after the shell appears.

The extension runs only on Linux (`extensionKind: ["workspace"]`). Local Linux is also supported for testing. It has no WebView, multiplexing UI, custom PTY renderer, SSH manager, terminal commands injected with `sendText`, or runtime npm dependencies.

Earlier experimental builds with a different extension ID are separate installations. Their metadata is not automatically imported. Finish and close their persistent tabs with the original extension before uninstalling it; installing this preview does not terminate those sessions.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `shpool.path` | empty | Use the bundled runtime. An explicit path or PATH command overrides it; external shpool must be exactly 0.11.4. |
| `shpool.socketPath` | empty | Bundled mode uses a private versioned socket below `$XDG_RUNTIME_DIR/vscode-shpool` (fallback `~/.local/run/vscode-shpool`). |

Both settings are machine-scoped. `~/` is expanded; shell expressions are not evaluated. Existing metadata keeps its original executable/socket, so changing settings cannot redirect a delayed kill to a different backend. The shell starts in the first workspace folder; existing sessions keep their actual current directory.

## Bundled runtime and upgrades

The Linux x64 VSIX contains the official static musl build. `runtime.lock.json` pins its version, source commit, archive SHA-256 and executable SHA-256. Downloads and extraction happen only during the build; installation and use are offline. There are no runtime npm dependencies.

On first use, the verified executable is copied into an immutable, versioned cache under the state directory. Saved sessions retain that executable and socket even when VS Code removes an older extension installation. Upgrading never restarts a daemon or kills existing sessions. Old runtime files are intentionally retained while sessions may depend on them. Do not remove the state directory while using persistent terminals. Explicit `shpool.path` overrides use the external daemon defaults when no socket override is given.

Before returning a new profile, the extension creates only the shell with `attach --background`, waits for its temporary client to detach, and durably records the shell generation. The actual terminal process is still direct `shpool attach <name>`. This closes the immediate-trash race without a shell wrapper or startup command.

The extension is MIT licensed; shpool is Apache-2.0. Bundled third-party notices are in `third_party/`. Linux arm64 and non-Linux backends are not included in this first preview.

## Lifecycle

| Event | Extension action |
| --- | --- |
| Individual terminal trash / Kill Terminal (`User`) | Save removal intent, independently invoke `shpool kill` for that identity after checking shell generation and attachment ownership. |
| Window close / reload (`Shutdown`) | Keep metadata; never kill. |
| SSH/network loss, VS Code/extension host crash | Keep metadata; never kill. shpool retains the shell. |
| Inner shell `exit` (`Process` and confirmed absent session) | Remove metadata; no redundant kill and no future resurrection. |
| Client detach / failed attach (`Process` but session exists) | Keep identity; do not treat the client as the inner shell. |
| `Extension`, `Unknown`, missing exit status | Keep metadata; never kill. |
| Server reboot | Saved identities can recreate fresh shells under the same names. This cannot restore processes lost with the server. |

Identity uses a UUID, workspace, persistent type, session name, backend and observed shell generation. A per-user server directory (`$XDG_STATE_HOME/vscode-shpool-terminal`, otherwise `~/.local/state/vscode-shpool-terminal`) holds the authoritative metadata, atomic name reservations and workspace lock files. Metadata is written using atomic rename and file/directory fsync before launching or killing a client, with a remote `workspaceState` mirror. This matters because VS Code can buffer workspaceState writes across an abrupt crash. Display names and terminal indices are never identity. Names use an ASCII-safe subset and fall back to `persistent-N`. Reserved names are never recycled; same-basename workspaces get the next unused number. Settings Sync is not used for identities.

Only one extension host can manage a given canonical workspace at a time. An OS advisory lock prevents concurrent windows or VS Code profiles from racing metadata or stealing the same sessions. A second window can still use ordinary terminals; Shpool Persistent creation reports the ownership conflict. The kernel releases the lock when its helper's pipe closes after host exit/crash. A live but disconnected host retains ownership; reconnect to that window rather than opening a competing one.

## Restoration and force attach

VS Code's [native persistence](https://code.visualstudio.com/docs/terminal/advanced) distinguishes reconnecting the existing terminal process (reload) from reviving its original executable/environment (restart). Recommended user settings:

```json
{
  "terminal.integrated.enablePersistentSessions": true,
  "terminal.integrated.persistentSessionReviveProcess": "onExitAndWindowClose"
}
```

The extension does not change these settings. Native layout/scrollback restoration remains VS Code's responsibility. After activation, the extension adopts native terminals using their saved creation identity and fills missing tabs. There is no public “all terminals restored” API; the startup grace period is not treated as a correctness guarantee. Actual shpool attachment PIDs identify the attached client, and a late duplicate is disposed with extension semantics, never killed. When native persistence is disabled or cannot revive a tab, fallback creates a native terminal with the same name; exact split layout and VS Code scrollback cannot be reconstructed by the fallback.

VS Code 1.121.0 was observed returning incomplete `creationOptions` after native restore. On Linux, the extension verifies the terminal PID's `/proc` executable, argument array and private identity environment marker to recover the mapping. It never logs or saves the process environment. If `/proc` cannot be inspected, it keeps the session rather than inferring identity from the tab name.

New and ordinary restored sessions use plain `attach`, never unconditional `--force`. If an existing client still holds a session, a native notification offers **Take Over**. Accept only for a stale client: this disconnects that client and uses force attach. The generation and attachment PIDs are rechecked after consent. Dismissing the notification leaves the running shell untouched; **Shpool Persistent: Restore Terminals** retries without requiring you to remember names. This deliberately chooses one confirmation over silently stealing a live session.

A force-created client opts out of native persistence (`isTransient: true`) for that attachment only, so VS Code cannot silently replay a saved `--force` on a later restart. Metadata remains persistent; subsequent fallback uses plain attach and restores native persistence. This exceptional path cannot preserve that tab's native split/scrollback layout across reload.

## Limits and troubleshooting

- Persistent terminal display rename is unsupported and does not rename the underlying shpool session. If you rename a tab anyway, closing it still targets the saved identity.
- Running arbitrary programs is supported, but shpool controls its shell configuration and process cleanup. A daemonized program that deliberately escapes the shell's process group is outside the extension's control.
- An inaccessible daemon or an attachment taken over by another client can leave a stale session. A notification explains when cleanup cannot safely be verified. There is no blind/background kill retry.
- VS Code restoration and exit-event behavior depends on version and remote connection state. A process that exits entirely while the extension is offline cannot be distinguished from a server losing that session; retained metadata may create a fresh shell. See the honest [acceptance record](docs/acceptance.md).
- Existing terminals created before installation are not imported by matching their names. Dragging persistent terminals between different workspaces is outside the MVP's supported identity lifecycle. Disabling/uninstalling the extension leaves shpool shells alive.
- View **Output → Shpool Persistent** for lifecycle/error diagnostics. Metadata and diagnostics do not record shell contents or commands.

## Build and test

Use Node.js 24 LTS and the committed lockfile:

```sh
npm ci
npm run runtime:fetch
npm run check
npm run test:shpool
npm run test:vscode
npm run package
```

`npm run test:shpool` uses Python 3, a real shpool binary and an isolated temporary daemon/PTYs. It never touches existing sessions. `npm run test:vscode` requires an official VS Code Desktop executable and Xvfb on headless Linux; see [acceptance](docs/acceptance.md). Build output and VSIX live in ignored `out/` and `artifacts/`; source, tests and lockfile are retained. No publishing or Marketplace credentials are needed to install the VSIX.

Implementation research and sources: [plan](docs/implementation-plan.md).
