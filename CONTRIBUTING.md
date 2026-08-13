# Contributing

Thanks for working on the LeRobot Local Dataset Visualizer. This document covers
the branch/PR workflow and the checks your change has to pass. For environment
setup, the local dataset root, and how to run the app, see [README.md](README.md);
for how the code is organised, see [CLAUDE.md](CLAUDE.md).

## Package manager

Always **bun**. Never npm or yarn — a stray `package-lock.json` or `yarn.lock`
will be rejected in review.

```bash
bun install
bun dev
```

## Before you push

Run these from the repo root and fix everything they report:

```bash
bun run format && bun run validate
```

`format` applies Prettier; `validate` then runs type-check → lint →
format:check → tests. CI runs the same checks, so a clean local run means a
green PR.

Individually, if you want to narrow things down:

| Command              | What it does                                        |
| -------------------- | --------------------------------------------------- |
| `bun run format`     | Prettier, write mode                                |
| `bun run type-check` | `tsc --noEmit` for both the app and the test config |
| `bun run lint`       | ESLint (`next lint`)                                |
| `bun test`           | Unit tests (`bun:test`)                             |
| `bun run validate`   | All of the above, check-only                        |

Tests live in `**/__tests__/` next to the code they cover. Pure helpers should
come with tests — most of the tricky logic in this repo (parquet path building,
histogram binning, subtask segments, language atoms) is pure precisely so it can
be tested without a dataset on disk.

## Branches

Org members have write access to this repository, so **work on a topic branch
here — you do not need a fork.** Never commit to `main` directly.

```bash
git checkout main && git pull
git checkout -b feat/my-thing
```

Name the branch `<type>/<short-slug>` using the same type as your commits:

```
feat/subtask-annotation
fix/histogram-payload
perf/lazy-load-card-thumbnails
docs/contributing
chore/update-repo-url
```

Please don't develop on your fork's `main`. It blocks you from opening a second
PR, it makes your fork drift from upstream, and it means a maintainer who wants
to push a fixup has to write to your default branch.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), with a scope when
one is obvious:

```
feat(parquet): raw parquet table browser tab
fix(dev): auto-recover from stale-chunk ChunkLoadError
perf(homepage): lazy-load card thumbnails via shared HoverPlayVideo
refactor(episode-length): derive histogram bin membership on the client
docs(readme): point clone URL at XenseRobotics-AI after transfer
ci: remove upstream HF-Space deploy workflow
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `ci`, `test`.

Write the body for the reviewer who arrives in six months: what was wrong, why
this fix, and anything you deliberately left out.

## Pull requests

`main` is protected. Every change lands through a PR that has:

| Requirement                   | Detail                                              |
| ----------------------------- | --------------------------------------------------- |
| No direct pushes to `main`    | Enforced — `git push origin main` is rejected       |
| **1 approving review**        | From anyone with write access other than the author |
| **`test`** passing            | `bun test`                                          |
| **`type-check`** passing      | type-check + lint + format:check                    |
| Branch up to date with `main` | Merge or rebase `main` in if CI says it's stale     |
| No force-push to `main`       | Enforced                                            |

New commits dismiss existing approvals, so push your fixups before asking for a
re-review.

Repository admins can bypass these rules. That exists for emergencies — a broken
`main`, a stuck release — not as a shortcut around review.

### What makes a PR easy to review

- One concern per PR. A refactor plus a feature is two PRs.
- Say what you _didn't_ do and why. Deferred work is fine; silent gaps are not.
- Call out anything reviewers can't see from the diff: a payload-size change, a
  behaviour that is byte-identical, a migration that has to run first.
- If you touched something that CI doesn't cover — the 3D viewer, video
  playback, a real v3.0 dataset — say how you verified it by hand.

## Reviewing

Approve when you'd be comfortable owning the change. Blocking comments should
name a concrete failure: inputs, expected result, actual result. Style opinions
without a rule behind them are suggestions, not blockers.

Use GitHub's `suggestion` blocks for small edits — the author commits them with
one click, no round trip.

## Merging (maintainers)

Use a **merge commit**, not squash:

```bash
gh pr merge <n> --merge --delete-branch
```

Squashing rewrites the commits, which loses per-commit authorship and — when a
PR builds on someone else's branch — stops GitHub from recognising the original
PR as merged. That PR then shows as "closed", and its author gets no credit.

### External contributions from forks

Contributors without write access open PRs from a fork. To push a fixup onto
their branch instead of opening a competing PR:

```bash
gh pr view <n> --json maintainerCanModify   # must be true
gh pr checkout <n>
# commit your change
git push
```

This keeps the PR number, its review thread, and the author's credit intact.
Two limits: the contributor must have ticked "Allow edits by maintainers", and
GitHub does not permit maintainer pushes to forks owned by an **organisation**
(only user-owned forks).

If neither pushing nor asking the author works and you have to supersede the PR
with your own, branch off _their_ head so their commits are preserved, and merge
with `--merge` so GitHub still marks their PR as merged.

## CI

Two workflows run on every PR to `main` and on every push to `main`:

| Workflow                           | Check name   | Runs                                        |
| ---------------------------------- | ------------ | ------------------------------------------- |
| `.github/workflows/test.yml`       | `test`       | `bun test`                                  |
| `.github/workflows/type-check.yml` | `type-check` | type-check, `next lint`, `prettier --check` |

Both are required to merge. Neither has a `paths:` filter, and they must not get
one: a path-filtered workflow reports nothing on PRs that miss the filter, and
because these are required checks, such a PR would sit at "pending" and never
become mergeable. The full suite takes well under a minute, so running it on
every PR is cheaper than the failure mode.
