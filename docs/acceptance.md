# Acceptance record / 验收记录

Date / 日期: 2026-09-07.

The tests below distinguish real processes and real VS Code API execution from mocked lifecycle events. A Linux desktop Extension Host test is not a Mac Remote-SSH acceptance test. / 以下区分真实进程、真实 VS Code API 和模拟生命周期事件；Linux Desktop Extension Host 测试不能等同于 Mac Remote-SSH 验收。

## Reproducible checks / 可重复检查

```sh
# From the repository root, with Node.js 24 / 在扩展目录使用 Node.js 24
npm ci
npm run runtime:fetch
npm run check
npm run test:shpool

# Official VS Code Desktop binary, isolated Xvfb / 官方 Desktop 二进制，独立 Xvfb
VSCODE_EXECUTABLE=/absolute/path/VSCode-linux-x64/code \
  xvfb-run -a npm run test:vscode

npm run package
```

- `tests/lifecycle.test.cjs`: 16 tests for exit policy, identity validation, safe arguments, JSON failure, concurrent server reservations, a real OS ownership lock and durable metadata. / 16 项退出策略、身份、参数、JSON、并发预留、真实 OS 锁及持久化 metadata 测试。
- `tests/controller.test.cjs`: 14 tests running the production controller with a mock VS Code API and daemon: profiles, three names, mixed shells, rename, exact User kill, Process, Shutdown/Unknown/Extension, restoration, consent, storage on failure, cancellation and recovery from a lost/stale workspaceState mirror. / 14 项生产控制器测试，VS Code API 与 daemon 为模拟，包含状态副本丢失/过期时的恢复。
- `tests/shpool-integration.py`: real shpool **0.11.4**, Linux PTYs and an isolated daemon. Six groups passed: three names, attach-client SIGKILL with continuously running shell/loop, busy/force attach, independent exact kill, shell exit, empty-daemon fresh-shell recovery. / 真实 shpool 0.11.4 + Linux PTY + 独立 daemon，六组测试通过。
- The PTY harness must set a nonzero terminal size. Without this, screen restoration can fail for reasons unrelated to VS Code. / PTY 测试需设置实际终端尺寸，否则屏幕恢复可能失败。
- shpool 0.11.4 can exit **0** on a busy attach. Consequently neither `Process` nor exit code 0 proves the inner shell exited. / attach 被占用时可能返回 0，不能据此删除 metadata。

## Native VS Code / 原生 VS Code

The checked-in fixture creates actual terminals using the contributed profile, executes the native Kill Terminal command, sends shell exit, reloads the window, closes/reopens the application, and SIGKILLs the isolated application process group. It asserts unchanged shell PID/generation and absence of duplicate/resurrected tabs. Test output is kept in the printed `/tmp/vscode-shpool-vscode-*` directory rather than committed. / 已提交的测试驱动使用真实 profile、Kill Terminal、shell exit、Reload、关闭重开及独立应用 SIGKILL，核实 PID、session 代际及重复/误复活；输出保存在终端打印的临时目录，不提交。

Executed on official **VS Code 1.121.0**, commit `f6cfa2ea2403534de03f069bdf160d06451ed282`, Linux x64 under Xvfb, with shpool 0.11.4. The official archive SHA-256 was verified as `8cf24cc41441453e11e8fe1ae9e58d32970e23dced399835c4b0904263d66820`. / 已在官方 VS Code 1.121.0、Linux x64/Xvfb、shpool 0.11.4 上实际运行，并校验官方安装包 SHA-256。

Passed: native profiles and mixed ordinary/persistent terminals (1–4); exact User kill and unaffected neighbors (8,13); shell exit (9); Reload with unchanged shell PID/generation and no duplicate/resurrected tabs (6); full application close/reopen (7); SIGKILL of the isolated app followed by automatic same-session recovery (10); killing the restored terminal. Native reload/quit generated Shutdown, the native kill action generated User, and shell exit generated Process. / 已通过：原生 profile 与混用、精确 User kill、shell exit、Reload、应用关闭重开、独立应用 SIGKILL 后自动恢复及恢复后关闭；实际退出原因为预期的 Shutdown / User / Process。

The native test uncovered two production-relevant behaviors that mocks did not prove: (1) restored `creationOptions` could contain only the default shell path, requiring verified Linux `/proc` identity adoption; (2) an awaited `workspaceState.update()` was lost by an immediate crash, requiring an authoritative atomic/fsynced metadata file. / 原生实测发现：恢复后的 creationOptions 可能仅有默认 shell 路径；workspaceState.update 返回也不保证立即刷盘。对应增加了 /proc 身份核验和原子 fsync metadata 文件。

The final run additionally killed `test-project-4` after native Reload, when its API creationOptions reported only zsh; the correct shpool session disappeared and `test-project-1` continued unchanged. Eight native test groups passed. Local evidence: `/tmp/vscode-shpool-vscode-4k1pCv/events.jsonl`. / 最终实测额外关闭原生 Reload 后 creationOptions 仅显示 zsh 的 `test-project-4`，正确删除对应 shpool session，`test-project-1` 不受影响；八组原生测试通过。

## Mac Remote-SSH acceptance / Mac Remote-SSH 验收

**Not executed here:** this session has Linux filesystem/process access but no control of the user's Mac VS Code or SSH network connection. No actual server reboot or user-window crash was performed. The isolated daemon reset is a reboot simulation only. / **当前未执行**：本会话无法操作用户 Mac VS Code 或 SSH 网络；未重启实际服务器、未强杀用户窗口。独立 daemon 重置只是 reboot 模拟。

Use a disposable trusted workspace named `test-project`. Install the VSIX on the SSH side. In the table, “pending” always refers to the actual Mac-to-Linux Remote-SSH path, not the Linux tests above. / 使用独立 `test-project` 工作区并在 SSH 端安装 VSIX；下表待验收均指实际 Mac→Linux Remote-SSH 链路。

| # | Action / 操作 | Required result / 预期 | Remote-SSH |
| --- | --- | --- | --- |
| 1 | New zsh / 创建普通 zsh | Native zsh process; no shpool / 普通 zsh，不经过 shpool | Pending / 待验收 |
| 2 | One Shpool Persistent / 创建一个 | tab and session both `test-project-1` / 名称一致 | Pending / 待验收 |
| 3 | Create three / 连续创建三个 | Unique `-1`, `-2`, `-3` / 三个不同 session | Pending / 待验收 |
| 4 | Mix zsh, bash and persistent / 普通与持久化混用 | All usable; defaults unchanged / 全部正常，默认不变 | Pending / 待验收 |
| 5 | Run `while true; do date; sleep 2; done`, disconnect SSH / 循环运行时断连 | Loop continues; reconnect original tab / 程序持续，自动回来 | Pending / 待验收 |
| 6 | Developer: Reload Window | Same shell PID/generation, one tab / 同一进程，无重复 | Pending / 待验收 |
| 7 | Close whole window; reopen / 关闭窗口后重开 | Session survives and reattaches / session 存活且恢复 | Pending / 待验收 |
| 8 | Trash a running persistent tab / 垃圾桶关闭运行中终端 | Corresponding session and shell terminate / 对应 session 与 shell 结束 | Pending / 待验收 |
| 9 | Type `exit`; restart / exit 后重启 | Deleted identity never recreated / 不误复活 | Pending / 待验收 |
| 10 | Crash disposable VS Code; reopen / 强杀独立测试 VS Code 后重开 | Shell survives, same identity restored / shell 存活并恢复 | Pending / 待验收 |
| 11 | Reboot disposable server / 重启独立测试服务器 | Fresh same-name shells; no retry loop / 同名新 shell，无无限报错 | Pending / 待验收 |
| 12 | Leave a stale attachment / 制造旧 attachment | Plain attach or explicit Take Over notification / 正常恢复或确认接管 | Pending / 待验收 |
| 13 | Close only `project-2` / 只关中间终端 | `project-1`, `project-3` unchanged / 其余不受影响 | Pending / 待验收 |

For process continuity, save `echo $$` and session `started_at_unix_ms` before the event; the same values must remain afterward. For the close race, confirm the session disappears even when the attach client has already exited. / 测试前记录 `echo $$` 及 session 的 `started_at_unix_ms`，之后核对不变；关闭 race 应确认 backing client 退出后仍完成对应 session 清理。

## API and CLI research / API 与 CLI 研究

- `TerminalExitReason`: use the explicit stable enum; only User is destructive evidence. / 仅 User 是破坏性操作的明确依据。
- `enablePersistentSessions`: controls native persistence; `persistentSessionReviveProcess` distinguishes restart behavior. The extension does not override either setting. / 扩展不修改用户设置。
- Public Terminal API has no restoration-complete event or transactional shpool ownership primitive. Grace period alone cannot guarantee ordering. / 公开 API 没有恢复完成屏障，固定等待不构成保证。
- `shpool list --json` exposes session generation and attachment PID. `attach --force` displaces an existing client. `kill` targets the shell. / JSON 提供代际与 PID，force 断开旧 client，kill 结束 shell。
- The CLI has no conditional “kill only generation X” operation. The extension checks just before kill and permanently reserves its names, but cannot make an external manual kill-and-recreate of the same name atomic with its check. Do not manually reuse extension-owned names. / CLI 无条件式 kill；扩展临近 kill 核验且不复用名称，但无法将外部手工重建同名 session 与检查组成原子操作，请勿手工复用扩展管理的名称。

Official source links are in [implementation-plan.md](implementation-plan.md). / 官方来源见实施计划。

## Bundled runtime / 内置运行时

The standalone 0.2.0 source was retested with the pinned static binary and no `shpool.path` or `shpool.socketPath` setting. Eight native groups passed again; evidence: `/tmp/vscode-shpool-vscode-4k1pCv/events.jsonl`. The backend path points into the immutable runtime cache, and the socket is private/versioned. Two runtime tests additionally cover concurrent installation, preserved inode, missing old extension files, corrupt cache/bundle rejection and unsupported targets. / 0.2.0 已在未配置外部路径和 socket 的默认内置模式下重测通过；另验证缓存并发、升级路径、校验失败及平台限制。

The native run exposed an asynchronous shpool `attach --background` detach transition; preparation now waits with a bounded retry before returning the terminal profile. / 原生实测发现 background 临时 client 的 detach 存在异步窗口，现已在返回 profile 前有界等待。

The built Linux x64 VSIX was installed through the official VS Code CLI into an isolated extensions directory (not loaded as the product development checkout). All eight native groups passed with the bundled default backend. Evidence: `/tmp/vscode-shpool-vscode-ZfcgIu/events.jsonl`. / 已通过官方 CLI 实际安装 VSIX 后再次验证八组原生测试，使用默认内置后端。

The final installed-VSIX run passed **nine** native groups, including immediate trash before the first observation tick. Evidence: `/tmp/vscode-shpool-vscode-W4RF74/events.jsonl`. This exposed and fixed the interval where VS Code has not published processId but shpool still lists the dying client: close now waits briefly and rechecks ownership before its single kill. / 最终安装包实测九组通过，包含首次观察前立即关闭；修复了 PID 尚未提供而 daemon 仍列出退出中 client 的窗口，关闭仅有界等待并重新核验，再执行一次 kill。
