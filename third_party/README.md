# Bundled runtime provenance

The extension code is MIT licensed. The unmodified shpool 0.11.4 executable is separately Apache-2.0 licensed. `runtime.lock.json` pins the official Linux x64 musl asset and its hashes. No Rust source is compiled by this extension's build.

- shpool source: https://github.com/shell-pool/shpool/tree/3a1020c74d1ac8eb191270922d834aa452cac816
- Build recipe: `.github/workflows/build_binaries.yml` at that revision. `rust-toolchain.toml` declares Rust 1.85.0; the upstream workflow also installs its cross-toolchain. The binary hash, rather than an inferred build environment, identifies the shipped artifact.
- `shpool-Cargo.lock` is copied from that source revision. `dependencies.json` records crate versions, declared licenses, source URLs and verified archive checksums. `DEPENDENCY-NOTICES.txt` includes license texts extracted from the corresponding crates, plus upstream notices where crates omit them. The inventory intentionally includes a superset of dependencies and build/test crates, excluding Windows/WASM-only crates.
- shpool, libshpool and shpool-protocol workspace components share `shpool-LICENSE`.
- motd license: https://github.com/shell-pool/motd/blob/8fc47b0bf149f1567a6ff2e771e785749472bf2d/LICENSE
- valuable license: https://github.com/tokio-rs/valuable/blob/9efc29b6e58cef28f6566a47aa7e142a55fead77/LICENSE
- r-efi notice: `AUTHORS` from the checksum-verified 6.0.0 crate. The MIT/Apache options are available; the alternative LGPL declaration is not imposed on the extension.
- Rust notices: https://github.com/rust-lang/rust/tree/1.85.0 (the Apache text is the same standard Apache-2.0 grant).
- musl notice: https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT (retrieved 2026-09-07).

On a runtime update, refresh this inventory and review licenses before packaging. These notices do not replace the component authors' original terms.

扩展代码采用 MIT；内置 shpool 及其组件保留各自许可证。运行时由固定校验值标识；更新版本时须同步审阅和更新本目录的来源与许可证清单。
