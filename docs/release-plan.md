# Release plan

Keep the product narrow: native VS Code terminals with shpool persistence. No custom UI, automatic application startup, session manager or SSH management.

1. Ship checksum-pinned shpool 0.11.4 for Linux x64. Cache immutable binaries outside the versioned extension installation and use a private versioned socket by default. Preserve old runtime paths for existing sessions.
2. Harden startup/close races, bounded observation, storage failures and workspace ownership. Keep explicit confirmation for taking over occupied sessions.
3. Test the packaged extension without system shpool, native restore, crash, upgrade preservation and Linux Remote-SSH where available. Mark Mac/reboot checks honestly. Add reproducible CI, third-party notices and a release checklist.
4. After development and verification, move this standalone package to the requested repository root, verify the copy, remove the old tools copy, then push to vaporhug/vscode-shpool-terminal. Prepare installable release artifacts; Marketplace publication requires a configured publisher.
