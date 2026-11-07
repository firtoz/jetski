# Release notes

Run `npm run changeset` for a user-facing change, then commit the generated file.
After main CI passes, automation maintains a Release PR. A maintainer merges that
PR; successful CI on that merge authorizes automatic publication. Ordinary commits
and unmerged release branches cannot publish. See [the release guide](../docs/releases.md).
