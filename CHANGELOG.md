# Changelog

## 0.2.0 — First standalone preview / 首个独立预览版

- Native Shpool Persistent terminal profile, automatic names and stable identities. / 原生 profile、自动命名和稳定身份。
- Explicit User close cleans the corresponding session; reload, disconnect and crash preserve shells. / 主动关闭清理对应 session，重载、断连和 crash 保留 shell。
- Checksum-pinned shpool 0.11.4 bundled for Linux x64; immutable runtime cache survives extension replacement. / 内置校验固定版本运行时，缓存不随扩展替换删除。
- Durable metadata, workspace ownership lock, native restoration adoption and explicit occupied-session takeover. / 持久化 metadata、工作区锁、原生恢复识别和确认接管。
- No automatic application startup, extra terminal UI or runtime npm dependencies. / 无自动程序启动、自定义终端 UI 或运行时 npm 依赖。

Validated with isolated Linux Desktop and real shpool PTYs. Actual Mac Remote-SSH and server reboot acceptance remain release gates for a stable version. / 已验证独立 Linux Desktop 和真实 shpool PTY；稳定版仍需实际 Mac Remote-SSH 与服务器 reboot 验收。
