# Shpool Persistent Terminal

[English](README.md)

一个轻量的 VS Code 扩展：通过 shpool 持久化原生集成终端。只负责 shell 的创建、恢复和关闭；不自动启动 Codex 或其他程序，不增加终端管理面板。

## 安装与使用

1. 使用 **VS Code 1.121 或更新版本**，通过 Remote-SSH 连接 **Linux x64**。服务器需有 `util-linux` 的 `/usr/bin/flock` 和 `/bin/cat`。VSIX 已内置固定版本 **shpool 0.11.4**，无需额外安装 shpool 或 Rust。
2. 执行 **Extensions: Install from VSIX…**，选择 `vscode-shpool-terminal-0.2.0-linux-x64.vsix`。确认安装在 **SSH: 服务器** 一侧；可通过 **Developer: Show Running Extensions** 核实运行位置。
3. 打开可信工作区，选择 **Terminal → New Terminal 下拉菜单 → Shpool Persistent**。

例如工作区为 `ResearchClawBench`，终端和 session 自动命名为 `ResearchClawBench-1`、`ResearchClawBench-2`。默认终端及 bash/zsh profile 不变，可自由混用。进入 shell 后自行执行任何命令。

扩展声明 `extensionKind: ["workspace"]`，后端仅在 Linux 运行；也可在本地 Linux 使用。没有 WebView、自定义 PTY 渲染、SSH 管理、自动命令注入或运行时 npm 依赖。

## 内置运行时与升级

Linux x64 VSIX 包含官方静态 musl 构建。`runtime.lock.json` 固定版本、源代码 commit、下载包和二进制的 SHA-256。下载和解压仅发生在构建阶段，安装及使用不需要网络。

首次使用会校验二进制并保存到状态目录下不可覆盖的版本化缓存。每个 session 保存自己的运行时路径和 socket；VS Code 删除旧扩展安装目录不会删除运行时。升级不会重启 daemon 或 kill 会话。旧运行时缓存会保留，请勿在仍需恢复终端时删除状态目录。

为解决创建后立即点击垃圾桶的竞态，扩展先用 `attach --background` 创建普通 shell，等待临时 client 脱离并持久化 shell 代际，再返回 profile。终端 backing process 仍然是直接 `shpool attach <name>`，不经过 shell 包装，也不自动运行其他程序。

扩展采用 MIT 许可证，shpool 采用 Apache-2.0；附带许可证位于 `third_party/`。首个预览版仅支持 Linux x64，未包含 arm64 或非 Linux 后端。

## 配置

| 配置 | 默认行为 |
| --- | --- |
| `shpool.path` | 留空使用内置运行时；可指定外部可执行文件绝对路径或 PATH 中的命令，版本必须为 0.11.4。 |
| `shpool.socketPath` | 留空时，内置模式在 `$XDG_RUNTIME_DIR/vscode-shpool` 下使用独立版本化 socket；无该变量时使用 `~/.local/run/vscode-shpool`。外部运行时模式使用 shpool 自己的默认 socket。可指定绝对路径覆盖。 |

配置限定于机器，支持 `~/`，不执行 shell 表达式。已有 session 保留原 backend，修改配置不会把延迟的 kill 指向另一个 daemon。新 shell 从第一个工作区文件夹启动，已有 shell 保留实际当前目录。

## 生命周期

| 事件 | 行为 |
| --- | --- |
| 单个终端垃圾桶 / Kill Terminal（User） | 先持久化删除意图，核验 shell 代际与 attachment 后，由远程扩展宿主独立执行对应 session 的 kill。 |
| 关闭窗口 / Reload（Shutdown） | 保留 metadata，不 kill。 |
| SSH / 网络断开、VS Code 或扩展宿主 crash | 不 kill，shpool 保留 shell。 |
| shell 自己 exit（Process 且确认 session 消失） | 删除 metadata，不重复 kill，下次不复活。 |
| client detach / attach 失败（Process 但 session 仍在） | 保留身份，不能把 client 退出当作 shell 退出。 |
| Extension、Unknown、无退出原因 | 保留 metadata，不 kill。 |
| 服务器重启 | 根据 metadata 创建同名新 shell；无法恢复随服务器丢失的进程。 |

身份包含 UUID、workspace、persistent 类型、sessionName、backend、shell 代际与 boot ID，不依赖显示名称或 terminal 列表位置。状态保存在 `$XDG_STATE_HOME/vscode-shpool-terminal`，没有该变量时为 `~/.local/state/vscode-shpool-terminal`。使用原子 rename 和文件/目录 fsync 持久化，workspaceState 仅为副本；实测 crash 可丢失已返回成功的 workspaceState 更新。

名称使用安全 ASCII 子集，无工作区名称时为 `persistent-N`。原子预留避免同服务器同用户的同名工作区冲突，编号不回收，不使用 Settings Sync 同步 session 身份。

一个 canonical workspace 同时仅允许一个扩展宿主管理。OS 锁阻止多个窗口或 profile 抢占；第二个窗口仍可使用普通终端。活着但断连的旧宿主保留所有权，应重连原窗口。宿主退出或 crash 后，管道关闭，内核释放锁。

## 恢复与接管

推荐用户设置（扩展不会修改）：

```json
{
  "terminal.integrated.enablePersistentSessions": true,
  "terminal.integrated.persistentSessionReviveProcess": "onExitAndWindowClose"
}
```

优先采用 VS Code 原生恢复，layout 和 scrollback 由 VS Code 管理。启动后识别原生已恢复终端，再补建缺失 tab。公开 API 没有恢复完成事件，因此不只依赖固定等待：核对 attachment PID，并在原生恢复晚到时清理重复 client，绝不因此 kill shell。关闭原生持久化或无法 revive 时，仍可恢复同名原生 tab，但不能重建精确 split layout 和 VS Code scrollback。

VS Code 1.121 原生恢复后可能只返回默认 shell 的 creationOptions；扩展核验 Linux `/proc` 中的 PID、可执行文件、参数和私有 identity 标记来恢复映射，不保存或记录进程环境。无法核验时保留 session，不凭显示名称猜测。

正常创建和恢复使用普通 attach。已有 client 占用时，通过原生通知提供 **接管 / Take Over**，只有确认后才 force attach；确认后再次核验代际和 attachment。关闭通知会保留原会话。命令 **Shpool Persistent: 恢复终端** 可重试，无需记忆 session 名。这一取舍避免多个正常窗口静默互相抢会话。

接管所得 client 使用 `isTransient: true`，防止 VS Code 下次 revive 自动重放 `--force`。metadata 仍保留，下次由扩展以普通 attach 恢复；此特殊路径不能保证该 tab 的原生 split/scrollback 恢复。

## 限制与排障

- 不支持修改 persistent terminal 显示名称；手动 rename 不会修改底层 session，关闭仍根据真实 identity 清理。
- daemon 不可访问、代际无法验证、attachment 被其他 client 接管时，可能保留 stale session，并给出错误提示。不做盲目 kill 或后台 kill 重试。
- 脱离 shell 进程组的 daemon 化程序不属于扩展可保证清理的范围。
- 扩展离线期间自然退出的 shell 与服务器丢失 session 无法完整区分；遗留 metadata 可能重建新 shell。
- 不通过名称导入安装前的终端；跨工作区拖动终端不在 MVP 支持范围。禁用或卸载扩展不会 kill 已有 shell。
- 首个预览版仍需实际 Mac→Linux Remote-SSH 和独立服务器 reboot 验收，详见[验收记录](docs/acceptance.md)。
- 查看 **Output → Shpool Persistent** 排障；metadata 和日志不保存终端内容或命令。

## 构建与测试

使用 Node.js 24 LTS、npm 和已提交的 lockfile：

```sh
npm ci
npm run runtime:fetch
npm run check
npm run test:shpool
npm run package
VSCODE_EXECUTABLE=/absolute/path/VSCode-linux-x64/code xvfb-run -a npm run test:vscode
```

shpool 集成测试使用 Python 3、真实二进制、独立 daemon 和 PTY，不操作用户会话。VS Code 测试使用独立 Desktop 配置和 Xvfb。构建输出 `out/`、`vendor/`、`artifacts/` 不提交到 Git；VSIX 可通过 Releases 分发。安装 VSIX 不需要 Marketplace 凭据。

[实现研究](docs/implementation-plan.md) · [验收记录](docs/acceptance.md)
