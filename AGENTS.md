# Project guidance

Read docs/implementation.md before continuing implementation and maintain its
acceptance matrix. Do not mark mock tests as hosted qualification. Keep public
content generic. Do not install runtimes on the operator's desktop. No paid
resources without a separate allowance. Run build, tests and lint after changes.

Keep the implementation plan concise. Replace current status instead of appending
run-by-run notes. Put stable design in docs/design.md and consolidated evidence in
docs/qualification.md; keep routine receipts and process handles in private local
QA notes. Read linked detail only when needed for the current work.

For Python host changes, also run CI's pinned formatter:
`uvx --from ruff==0.17.3 ruff format --check host examples/qualify-tty.py`.
User-facing changes need a changeset (`npm run changeset`). Versions are updated
by `npm run version:release`; do not bump only package.json.
