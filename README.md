# Verco plugins

Work toward an image optimization plugin for [EmDash](https://github.com/emdash-cms/emdash).
Optimizing existing media safely needs host support that EmDash does not yet provide: replacing
an image's bytes without changing its ID or URL, keeping the original, and never overwriting an
editor's concurrent change. This repository qualifies that host support first.

**Status: pre-release.** There is no installable plugin yet. Nothing here modifies media on a real site:
the plugin-side guard rejects apply and restore on every host, and all experiments use disposable
data.

## What is here

- `packages/media-host-adapter/`: reports whether a host supports safe media operations and
  rejects apply and restore unless it does. Scanning stays available.
- `experiments/` and `scripts/`: runnable qualification of the pinned EmDash commit, covering
  media delivery, concurrent writers and crash recovery on Node and SQLite.
- `host/emdash/`: the pinned EmDash commit (`target.json`), recorded evidence from the
  qualification runs, and host patches where present.
- `fixtures/`: a disposable Astro site used by the delivery qualification.

## Host patches

`host/emdash/patches/` holds patches against the pinned EmDash commit that add opt-in,
revision-fenced media replacement with private originals. `pnpm host:pilot` builds a patched
worktree and `pnpm host:qualify-patch` runs their tests. The patches are a pilot, not a
supported version range, and nothing in EmDash calls them unless a site sets `safeMedia`.
See `host/emdash/patches/README.md`.

## Requirements

Node 22.16 or later and pnpm 10.18.3 (or `npm exec --yes --package pnpm@10.18.3 -- pnpm <command>`).
Tests use Node's experimental TypeScript stripping and SQLite APIs. The pinned EmDash source is cloned
into the ignored `.upstream/` directory.

```sh
pnpm install --frozen-lockfile
pnpm test                    # Run the unit tests and experiments.
pnpm typecheck               # Type-check the TypeScript packages.
pnpm host:checkout           # Clone and select the pinned EmDash commit into `.upstream/emdash` (ignored).
pnpm host:qualify-delivery   # Build and run a disposable Astro fixture that checks stable direct, transformed and static image delivery.
pnpm host:qualify-writers    # Run the pinned EmDash editor handlers against a prototype revision fence on real SQLite connections.
pnpm host:qualify-recovery   # Run the journaled publication prototype through a simulated crash at every step.
pnpm host:measure-decoder    # Measure decode time and memory for still JPEG, PNG and WebP output and propose limits.
pnpm host:pilot              # Create `.upstream/emdash-pilot`: the pinned EmDash commit with the patches in `host/emdash/patches/` applied.
pnpm host:pilot-check        # Check that the patches apply to a pristine tree and produce the recorded git trees.
pnpm host:patch-export       # Export the pilot worktree's changes as the next patch.
pnpm host:qualify-patch      # Run the patches' tests in the pilot worktree.
```

Run `pnpm host:checkout` before the qualification commands.

## License

[MIT](LICENSE). Patches under `host/emdash/patches/`, where present, modify EmDash and carry its
MIT license; see the notice in that directory.
