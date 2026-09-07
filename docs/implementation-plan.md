# Implementation plan / 实施计划

1. Register a workspace extension TerminalProfileProvider; invoke shpool directly. Keep native profiles and default settings untouched. / 注册 workspace 扩展和原生 profile，直接执行 shpool，不修改默认终端。
2. Persist workspace, immutable UUID, session name, backend and observed generation. Reserve names atomically on the server and hold one OS workspace lock. / 保存稳定身份与后端，服务器原子预留名称并持有工作区锁。
3. Probe native process reconnection/revive before choosing restoration policy. Adopt restored terminals by creation identity; reconcile missing terminals without force. / 先实测原生恢复，按创建身份接管并补建缺失终端。
4. Only User permits kill. Check session generation and attachment ownership; Process checks actual session existence, not just client exit. / 仅 User 允许 kill，并核查 session 代际和客户端归属；Process 需核实内部 shell 是否仍存活。
5. Unit tests, isolated real shpool PTY tests, real VS Code Extension Host tests, Remote-SSH acceptance matrix, bilingual README and VSIX. / 单元测试、独立 shpool PTY 与 VS Code 实测、Remote-SSH 验收矩阵、双语文档及 VSIX。

Research sources (2026-09-07):
- https://code.visualstudio.com/api/references/vscode-api#TerminalExitReason
- https://code.visualstudio.com/api/references/vscode-api#TerminalOptions
- https://code.visualstudio.com/docs/terminal/advanced
- https://code.visualstudio.com/api/advanced-topics/remote-extensions
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadTerminalService.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalService.ts
- https://github.com/shell-pool/shpool/blob/master/README.md
- Installed shpool 0.11.4 CLI help and matching libshpool/shpool-protocol Rust sources.
