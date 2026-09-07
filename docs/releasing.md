# Release checklist / 发布清单

The first standalone artifact is a **preview**, not a claim that every Remote-SSH scenario has passed. / 首个独立包为预览版，不代表全部 Remote-SSH 场景已验收。

1. Run `npm ci`, `npm run runtime:fetch`, `npm run check`, real PTY tests and installed-VSIX Desktop tests. CI reproduces these checks. / 执行依赖安装、运行时校验、单元/PTY/安装包原生测试，CI 重复验证。
2. Complete the Mac Remote-SSH matrix in [acceptance.md](acceptance.md), including real connection loss, competing windows, stale attachment and disposable-server reboot. Record versions and evidence before claiming stable support. / 稳定版前完成实际链路验收并记录证据。
3. Review changes and third-party notices, update version/changelog/CI artifact name, build the Linux x64 VSIX and publish its SHA-256 alongside the release. / 更新版本与记录，审阅许可证，构建并附带 SHA-256。
4. A GitHub draft release can hold the reviewed VSIX. Marketplace publication additionally needs the `vaporhug` publisher to be registered and authorized; never commit a PAT. / GitHub 草稿可保存待审安装包；Marketplace 还需注册并授权 publisher，禁止提交 PAT。

Changing the shpool pin requires reviewing CLI/protocol changes and dependency licenses, updating both hashes, rerunning all tests, and preserving compatibility with old saved backend paths. Never delete old runtime caches or restart active daemons as part of an upgrade. / 更改运行时需重新审查、更新校验值并重测；升级不得删除旧缓存或重启活动 daemon。

The first preview targets Linux x64 and VS Code >=1.121. No Marketplace publication is performed automatically by CI. / 首版仅支持 Linux x64、VS Code >=1.121，CI 不自动发布 Marketplace。
