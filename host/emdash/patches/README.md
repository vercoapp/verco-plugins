# Pilot host patches

Verco-owned EmDash patches against the commit in [`../target.json`](../target.json).
[`patches.json`](patches.json) records each patch's SHA-256, resulting git
tree, changed files, related tests, scope and limits.

| Patch | Content |
| --- | --- |
| [`0001-media-revisions-private-originals.patch`](0001-media-revisions-private-originals.patch) | Migration 092, revision/original/operation records, digest-verified private originals, local private storage, public-route guard. |
| [`0002-bounded-output-validation.patch`](0002-bounded-output-validation.patch) | Output validator: header checks, animation and format refusal, digest declaration, admission budget and a killable Sharp child-process full decode. Adds Sharp as an optional peer. |
| [`0003-staged-replacement-receipts.patch`](0003-staged-replacement-receipts.patch) | Replacement service: staged immutable candidates, verified private originals, single-transaction publication with a durable receipt, idempotent resume, and the file route resolving stable keys to the active revision. |

Patches are cumulative and apply in order; each records the git tree it produces.

Create the patched worktree with `pnpm host:pilot` and verify that the patches
apply to a pristine tree with `pnpm host:pilot-check`. Export changes with
`pnpm host:patch-export <NNNN-name.patch> <task>...`; run a patch's tests with
`pnpm host:qualify-patch`, which refuses a worktree that differs from the
last exported patch and runs every patch's tests.

The patches are a pilot. They do not yet cover every consumer of media bytes, the plugin-facing
bridges, restore, or installation and rollback instructions, and they are not a supported version
range. A plugin adapter alone cannot establish safe media publication.

## License

The patches modify [EmDash](https://github.com/emdash-cms/emdash), which is licensed under the MIT License (Copyright 2026 Cloudflare Inc.). The patch files contain upstream context lines and are provided under the same terms; the rest of this repository is covered by [LICENSE](../../../LICENSE).
