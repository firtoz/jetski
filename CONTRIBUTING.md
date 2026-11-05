# Contributing

Use the Node version in `.nvmrc`. From a source checkout:

```sh
npm install
npm run typecheck
npm test
npm run lint
```

`npm install` runs the repository's `prepare` script to build the source. After
source edits, use `npm run build` to refresh the compiled output. CI uses `npm ci`
for a clean install that requires the lockfile to match the manifest.

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

New dependencies and extracted source require license/provenance review. Document
adapter capabilities honestly and retain failed qualification evidence.
