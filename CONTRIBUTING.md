# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so we can
agree on the approach before you write it.

## Set up

Node 22.16 or later and pnpm 10.18.3 (or prefix commands with `npx pnpm@10.18.3`).

```sh
pnpm install --frozen-lockfile
pnpm host:checkout     # Clones the pinned EmDash commit into the ignored `.upstream/` directory.
pnpm typecheck
pnpm test
```

`pnpm test` needs the pinned checkout: one experiment builds EmDash's media routes from it.

## Pull requests

- Branch from `main` and keep one change per pull request. To bring in newer `main`, merge it into
  your branch rather than rebasing a branch that others may have pulled.
- The suite must pass on Node 22.16 and on the current Node release; CI runs both.
- When you add a safeguard, remove it once on purpose and confirm that a test fails.
- Commit messages say why the change is needed, not only what it does.
- Do not commit media, credentials or personal data. Tests use disposable fixtures; the calibration
  scripts download their images into ignored directories.

[AGENTS.md](AGENTS.md) has the full conventions, including the rules for the host patches and their
qualification evidence.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
