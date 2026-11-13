---

name: reader-first-docs
description: Review, write or reorganize project READMEs and Markdown documentation around reader value, quick trials and practical tasks. Use for documentation curation, especially when user guides have accumulated development logs, plans or historical qualification notes.
---

# Reader-first project documentation

Write for a developer deciding whether the project helps them and how to use it.
Begin at the README: explain what the project does, when it is useful, why someone
would choose it, and the shortest honest way to try it. Link onward by the reader's
next task, with runnable examples and clear prerequisites. Keep advanced detail
available without making beginners assemble the architecture first.

For each document or section, identify its audience and the decision or action it
supports. Keep current behavior, concrete usage, relevant limits and evidence
needed to assess a claim. Prefer one authoritative explanation with focused links
over repeated summaries, exhaustive menus or several competing getting-started paths.
Concise means high useful-information density, not deleting necessary contracts.

Separate user guidance from material for working on the project itself. Put useful
implementation plans, architecture internals, qualification methods and supporting
measurements in a clearly named maintainer area with an entry README explaining
that ordinary users can skip it. Keep this area curated too: retain rationale,
reproducible evidence, consequential failures and unresolved limitations that can
change a future decision. Remove superseded plans, routine receipts, process
handles and "we did A, reverted it, then did B" narration; version control already
preserves history. Do not create a dumping-ground archive merely to avoid deletion.
Preserve established release changelogs, attribution and security/recovery records
when they serve their actual purpose; do not rewrite released history as a guide.

Describe the current supported state in user docs. Keep release availability,
security boundaries, destructive effects, durability conditions and measured-result
limitations explicit. Never turn mock tests into live qualification or erase a
material failed result while shortening evidence. Keep private credentials,
account-specific instructions and operational receipts out of public documentation.

Before moving or deleting material, inspect its inbound links and code/tooling
references. Repair navigation, anchors, local instructions and release tooling;
retain small compatibility entry points only where a real caller needs them.
Check that a new reader can reach a working first example, that task links lead
to actionable instructions, and that maintainer-only content stays off the normal
reading path. Validate affected examples, links and repository-required checks.
Respect the requested scope; documentation cleanup does not authorize deployment,
publication, paid resources or product behavior changes.
