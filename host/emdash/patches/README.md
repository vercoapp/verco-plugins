# Pilot host patches

Verco-owned EmDash patches against the commit in [`../target.json`](../target.json).
[`patches.json`](patches.json) records each patch's SHA-256, resulting git
tree, changed files, related tests, scope and limits.

| Patch | Content |
| --- | --- |
| [`0001-media-revisions-private-originals.patch`](0001-media-revisions-private-originals.patch) | Migration 092, revision/original/operation records, digest-verified private originals, local private storage, public-route guard. |
| [`0002-bounded-output-validation.patch`](0002-bounded-output-validation.patch) | Output validator: header checks, animation and format refusal, digest declaration, admission budget and a killable Sharp child-process full decode. Adds Sharp as an optional peer. |
| [`0003-staged-replacement-receipts.patch`](0003-staged-replacement-receipts.patch) | Replacement service: staged immutable candidates, verified private originals, single-transaction publication with a durable receipt, idempotent resume, and the file route resolving stable keys to the active revision. |
| [`0004-fenced-writers-and-readers.patch`](0004-fenced-writers-and-readers.patch) | Opt-in `safeMedia`: startup wiring, revision-aware storage for every reader, the editor replace route using the fenced service, legacy writers fenced. |
| [`0005-interrupted-operation-reconciliation.patch`](0005-interrupted-operation-reconciliation.patch) | Reconciliation: interrupted operations are completed through the fenced steps or aborted, and objects no record needs are removed, after startup, on maintenance ticks and on demand. One writing process is assumed. |
| [`0006-byte-exact-restore.patch`](0006-byte-exact-restore.patch) | Fenced byte-exact restore of a retained original through the same journal and receipts, and `emdash/media/safe-recovery`, a recovery entry point that works from the database and storage directories without the runtime or any plugin. |
| [`0007-native-safe-media-access.patch`](0007-native-safe-media-access.patch) | `ctx.media.safe` for native plugins that declare the native-only capability `media:bytes:replace` on a `safeMedia` host: support discovery, the active revision, same-geometry replace, restore, restorable originals and operation status, attributed to the plugin. Sandboxed-format plugins, in a sandbox or in-process, cannot declare the capability. |
| [`0008-read-retained-original.patch`](0008-read-retained-original.patch) | `ctx.media.safe.readOriginal`: the same native plugins read the digest-verified bytes of an original retained for a media item, without restoring it, within the `ctx.media.readBytes` limits. Read-only. |

Patches are cumulative and apply in order; each records the git tree it produces.

Create the patched worktree with `pnpm host:pilot` and verify that the patches
apply to a pristine tree with `pnpm host:pilot-check`. Export changes with
`pnpm host:patch-export <NNNN-name.patch> <task>...`; run a patch's tests with
`pnpm host:qualify-patch`, which refuses a worktree that differs from the
last exported patch and runs every patch's tests.

The patches are a pilot. They do not yet cover every consumer of media bytes, a bridge for sandboxed
plugins (only native plugins can reach replace, restore and original reads, and no route exposes them), or
installation and rollback instructions, and they are not a supported version range. Only Node,
SQLite and local storage are exercised; D1 and object storage are not supported. Reconciliation
assumes a single writing process; another process's work is protected only by a grace period.

The native access in `0007` is provisional: the capability name, the `ctx.media.safe` shape and
protocol version 1 may change. `support()` describes the configured host (runtime, database, storage,
in-process locks); it is not a statement that the host is qualified. A native plugin sees the access
only when `safeMedia` is configured, so its absence means the host offers no safe media operations.

`readOriginal(mediaId, sha256, { maxBytes })` in `0008` returns a typed result: the bytes, MIME type
and size of an original listed by `listRestorableOriginals(mediaId)`, or a refusal code
(`INVALID_REQUEST`, `MEDIA_UNAVAILABLE`, `NO_ORIGINAL`, `TOO_LARGE`, `ORIGINAL_MISSING`,
`ORIGINAL_CORRUPT`, or the retryable `ORIGINAL_UNREADABLE`). It refuses another item's originals and
deleted media, and returns no URL or storage key. `maxBytes` defaults to 10 MiB and may not exceed
16 MiB, the limits of `ctx.media.readBytes`, so larger originals cannot be read this way. The bytes are
held in memory in full.

To restore a media item with the site stopped and no plugin installed (Node, SQLite, local storage):

```js
import { openSafeMediaRecovery } from "emdash/media/safe-recovery";

const recovery = await openSafeMediaRecovery({
  databasePath: "./data.db",
  uploadsDirectory: "./uploads",
  privateDirectory: "./.emdash/private",
});
console.log(await recovery.listRestorableOriginals(mediaId));
console.log(await recovery.restoreMedia(mediaId)); // undoes the change that produced the active revision
await recovery.close();
``` A plugin adapter alone cannot establish safe media publication.

## License

The patches modify [EmDash](https://github.com/emdash-cms/emdash), which is licensed under the MIT License (Copyright 2026 Cloudflare Inc.). The patch files contain upstream context lines and are provided under the same terms; the rest of this repository is covered by [LICENSE](../../../LICENSE).
