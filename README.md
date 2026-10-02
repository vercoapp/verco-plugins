# Verco plugins

Plugins for [EmDash](https://github.com/emdash-cms/emdash), maintained by Verco. This is a single
pnpm workspace: each plugin is its own package under `packages/`, versioned and published
independently, and all of them share one pinned EmDash target and one test setup.

## Plugins

| Package | Status | What it is |
| --- | --- | --- |
| `packages/media-host-adapter` | pre-release | Plugin-side guard for the image optimizer: reports whether a host supports safe media operations and rejects apply and restore unless it does. |
| `packages/image-optimizer` | in development | Read-only report of images that could be smaller, estimated from media metadata. Optimizing existing media needs host support that EmDash does not provide yet; see below. |

There is no installable plugin yet. Nothing here modifies media on a real site, and all experiments
use disposable data.

## Shared tooling

- `host/emdash/`: the pinned EmDash commit (`target.json`), recorded qualification evidence, and host
  patches where present.
- `experiments/`, `scripts/` and `fixtures/`: runnable qualification of the pinned EmDash commit for
  safe media operations (delivery, concurrent writers, crash recovery) on Node and SQLite. These
  currently serve the image optimizer only.

## Image optimizer: host support

Optimizing existing media safely means replacing an image's bytes without changing its ID or URL,
keeping the original, and never overwriting an editor's concurrent change. EmDash's own replacement
route does none of that, so this repository qualifies the needed host support before the plugin
applies anything.

## Working in the repository

Node 22.16 or later and pnpm 10.18.3 (or `npm exec --yes --package pnpm@10.18.3 -- pnpm <command>`).
Tests use Node's experimental TypeScript stripping and SQLite APIs. The pinned EmDash source is cloned
into the ignored `.upstream/` directory; run `pnpm host:checkout` before the qualification commands.

```sh
pnpm install --frozen-lockfile
pnpm test                    # Run the unit tests and experiments.
pnpm typecheck               # Type-check the TypeScript packages.
pnpm host:checkout           # Clone and select the pinned EmDash commit into `.upstream/emdash` (ignored).
pnpm host:qualify-delivery   # Build and run a disposable Astro fixture that checks stable direct, transformed and static image delivery.
pnpm host:qualify-writers    # Run the pinned EmDash editor handlers against a prototype revision fence on real SQLite connections.
```

### Adding a plugin

Create `packages/<name>/` with its own `package.json` (name, version, `license`, and
`repository.directory`), a README that says what the plugin does and its status, and its own tests.
Use the shared EmDash pin in `host/emdash/target.json` rather than a copy. Keep plugin-specific
tooling inside the plugin's directory or name its scripts after the plugin.

## License

[MIT](LICENSE). Patches under `host/emdash/patches/`, where present, modify EmDash and carry its
MIT license; see the notice in that directory.
