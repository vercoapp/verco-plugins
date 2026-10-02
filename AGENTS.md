# Agent notes

Instructions for AI coding agents and contributors working in this repository. The repository is
**public**. Read the publication rules before committing anything.

## Publication rules

These exist because an earlier history had to be rewritten before the repository could be published.

- **No personal data in tracked files or commits.** Never commit absolute home-directory paths
  (`/Users/...`), machine or account names, personal email addresses, or references to private notes
  or vaults. Use repository-relative paths.
- **Commit identity.** Commits use the GitHub noreply address already set in this repository's local
  git config (`git config --local user.email`). Check it before committing. Do not change it, do not
  use a personal address, and do not pass `--author` with one. If a tool reports a different
  identity, fix the local config rather than committing.
- **Local-only documents stay local.** `docs/` and `openspec/` are git-ignored: plans, ADRs,
  qualification reports and the OpenSpec change live on the maintainer's machine only. Never
  `git add -f` them, and never move their content into tracked files. Do not link to them from tracked
  files (README, code comments, JSON evidence, patch documentation, commit messages). User-facing
  documentation belongs in `README.md` and `host/emdash/patches/README.md`.
- **Product roadmap and estimates are not for public files.** Pricing, billing plans, managed-service
  plans, effort estimates, and competitor-parity strategy live only in the local documents.
- **No secrets or real data.** Experiments use disposable fixtures. Never commit credentials, API
  keys, tokens, real media, or provider account details. Qualification evidence may record the
  hardware and Node version of the run, nothing more identifying.
- **Licensing.** The repository is MIT (`LICENSE`). Patches in `host/emdash/patches/` modify EmDash
  (MIT, Copyright 2026 Cloudflare Inc.) and must keep the notice in that directory's README.
  Do not vendor upstream source into the repository; the pinned checkout lives in the ignored
  `.upstream/` directory.

Before every commit run a quick scan of what is staged and fix anything it finds:

```sh
git diff --cached -- . ':!AGENTS.md' | grep -n -E "/Users/|@gmail|docs/|openspec/" || true
git log -1 --format='%an <%ae>'   # must be the noreply identity
```

History rewrites are reserved for the maintainer's explicit request. Never push, force-push or
delete branches on your own initiative.

## Branches

`main` holds the qualification prototypes. `add-safe-media-operations` adds recovery and decoder
budgets. `safe-media-host-implementation` is stacked on it and adds the host patches. Add new work on
the most specific branch that needs it.

## Working conventions

- Node 22.16 or later; the suite must pass on both the oldest and the newest Node you have (the test
  runner output format differs between versions, so scripts consume `run()` events, not text).
  `pnpm` may be missing: use `npx pnpm@10.18.3 <command>` (the upstream checkout needs
  `npx pnpm@11.9.0`).
- Qualification evidence (`host/emdash/qualification/*.json`) is written only by a clean passing
  run. Do not edit it by hand, and do not describe anything as supported or qualified beyond what that
  evidence shows. Docs and READMEs must state limits plainly: this is a pilot, mutation is disabled by
  default, only Node, SQLite and local storage are exercised, D1 is deferred.
- Host patches are cumulative and tied to git trees. Change them only through the pilot worktree:
  `pnpm host:pilot`, edit `.upstream/emdash-pilot`, then `pnpm host:patch-export` and
  `pnpm host:qualify-patch`. `pnpm host:pilot-check` must pass. Never hand-edit a `.patch` file.
- In `.upstream/emdash-pilot`, format with `oxfmt --ignore-path /dev/null <files>` and lint with
  `oxlint --type-aware --deny-warnings <paths>`. Do not use bare `git stash` there.
- When adding a safeguard, break it once on purpose and confirm a test fails. Several tests first
  passed with the check removed, which showed they were too weak.
