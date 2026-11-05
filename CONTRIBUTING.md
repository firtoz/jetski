# Contributing

Use the Node version in `.nvmrc`. From a source checkout:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
```

Normal users install the prebuilt npm package or container; they do not build this
repository. `node scripts/qualify-package.mjs` checks a tarball in a clean consumer
with lifecycle scripts disabled. Docker runtime qualification runs on disposable
CI runners only. Hosted tests need an explicit spending allowance; never use
operator credentials, workloads or protected recovery fixtures as test data.

Keep the core portable and adapter boundaries explicit. Acknowledged data,
fencing and verified publication take precedence over optimizations. Add focused
checks for changed behavior and reuse unchanged qualification. See docs/design.md
and docs/qualification.md. Do not commit credentials, private receipts or application
integrations. Releases follow docs/releases.md.
