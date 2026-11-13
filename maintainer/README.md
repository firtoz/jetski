# Working on Jetski

This directory is for developing, qualifying and releasing Jetski itself.
**Ordinary library users should start with the [README](../README.md) or
[task guides](../docs/README.md); they can skip this directory.**

Keep material here only when it changes an implementation or verification decision.
Current contracts and scoped evidence are useful; completed task diaries, old
publication checklists and routine run receipts are not. Use version control for
archaeology and private local QA notes for process handles, account details and
operational receipts.

| Working on…                                   | Read                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Core architecture and invariants              | [Design](design.md)                                                              |
| Supported scope and acceptance                | [Implementation matrix](implementation.md)                                       |
| Host-runtime or transport contracts           | [Runtime boundary](runtime.md), [native host contract](../host-rust/contract.md) |
| Local checks and new adapter qualification    | [Testing](testing.md)                                                            |
| Evidence behind durability/performance claims | [Qualification](qualification.md), [benchmark reports](benchmarks/README.md)     |
| Versioning, release automation or recovery    | [Release process](release-process.md)                                            |
| Documentation work                            | [Reader-first documentation skill](../.agents/skills/reader-first-docs/SKILL.md) |

Historical observations retain their original build, workload and evidence limits.
A passing mock is not hosted qualification; a source change does not upgrade
installed consumers. Hosted resources need their own explicit allowance.
