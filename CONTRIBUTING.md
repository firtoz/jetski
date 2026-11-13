# Contributing

Library users can install the prebuilt package; start with the [README](README.md).
To work on Jetski itself, use the Node version in [`.nvmrc`](.nvmrc):

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
```

Read [maintainer documentation](maintainer/README.md) for design, acceptance,
qualification and release procedures. Keep core portable, preserve adapter
boundaries and verify publication before releasing acknowledged data.
Run focused checks for changed behavior and reuse unchanged qualification.
New dependencies or extracted code require license/provenance review.

Use the [reader-first documentation skill](.agents/skills/reader-first-docs/SKILL.md)
when editing Markdown: user guides explain value and actions; useful internals
belong in the maintainer area. Superseded plans and run diaries belong in version
history, not another archive. Keep credentials, application identities, process
handles and routine receipts out of public source.

Add a changeset for user-facing changes; use the existing
[release process](maintainer/release-process.md). Hosted tests need an explicit
allowance. Use disposable CI hosts for runtime qualification; do not install
runtimes on the operator's desktop or use protected recovery fixtures as test data.
