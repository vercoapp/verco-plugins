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
| [`0009-decoder-process-cleanup.patch`](0009-decoder-process-cleanup.patch) | Output-validator decoder cleanup: a timed-out decode or a failing spawn observer reports only after the child is killed and reaped, and a decoder child exits when its parent dies instead of being orphaned. |
| [`0010-public-active-revision.patch`](0010-public-active-revision.patch) | Public storage after publication: the stable key is rewritten with the active revision's bytes and the superseded revision object is removed, each only after the displaced bytes are verified in the private store. Migration 093 records the cleanup per operation; reconciliation finishes interrupted cleanups and cleans media replaced earlier. |

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
Originals are private only as described under [What the storage directory holds](#what-the-storage-directory-holds-after-a-replacement-0010).

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

### What the storage directory holds after a replacement (`0010`)

Before `0010`, a replaced media item kept its previous bytes at its stable key (`<id>.<ext>`) in the
storage directory, and every superseded revision stayed under `media-revisions/`. The host's own
routes never served them, but anything that reads the directory without going through the host did:
a file server or reverse proxy mounted on it, a CDN using it as an origin, a copy of it in a public
bucket, or an EmDash without these patches.

With `0010`, once an operation is published and its cleanup has run, the directory holds for that
media item only:

- the stable key, containing the active image (rewritten through a temporary file and a rename, so a
  reader sees the previous or the new file in full), and
- `media-revisions/<sha256>.<ext>`, the active revision, with the same bytes.

The previous bytes exist only in `safeMedia.privateDirectory`. Nothing public is overwritten or
removed until the same bytes are verified by SHA-256 in the private store and recorded; restore,
`readOriginal` and `listRestorableOriginals` read that store and behave as before.

Serving the storage directory directly therefore exposes the active image, and does not expose a
retained original that is no longer active. The limits:

- The rewrite follows the commit. Between the two the stable key still holds the previous bytes,
  which on a first replacement are the original. If the process stops in between, or the rewrite
  fails, that lasts until reconciliation finishes it (after startup and on maintenance ticks, once
  the 10-minute grace period has passed). The reconciliation report counts what is still owed as
  `pendingPublicCleanups`, and the host logs it.
- The host cannot invalidate a cache it does not know about. A CDN or proxy in front of the directory
  keeps serving what it cached, which may be the original.
- Media replaced before `0010` is cleaned by reconciliation, at most `limit` operations and `limit`
  superseded objects per run (1000 by default); until a run reports `complete` and no pending
  cleanups, originals are still in the directory.
- A stable key used by more than one media row is left as it is.
- Objects that were never retained as an original stay: the last revision of deleted media (its
  stable key is removed by the deletion; a revision holding a retained original is removed by
  reconciliation) and, until reconciliation removes them, candidates of interrupted operations and
  `media-revisions/stable-*.tmp` files of an interrupted rewrite.
- Only one writing process is assumed. Two processes publishing on the same item at the same moment
  can leave its stable key one revision behind.

This was exercised in tests against a local storage directory, including a scan of every file in it
after each operation. No deployment that serves the directory directly was run.

### Before disabling `safeMedia` or going back to an unpatched EmDash

Without `safeMedia`, readers that skip revision resolution (the image endpoint's storage shortcut,
and every reader of an unpatched EmDash) serve whatever is at the stable key. Bring every stable key
in line first: stop the site and run reconciliation until nothing is owed.

```js
import { openSafeMediaRecovery } from "emdash/media/safe-recovery";

const recovery = await openSafeMediaRecovery({
  databasePath: "./data.db",
  uploadsDirectory: "./uploads",
  privateDirectory: "./.emdash/private",
});
let report;
do {
  report = await recovery.reconcile({ graceMs: 0 }); // only while the site is stopped
} while (
  report.operations.length + report.mirroredStableKeys.length + report.removedSupersededObjects.length > 0
);
await recovery.close();
if (report.pendingPublicCleanups > 0 || report.complete === false) {
  throw new Error("Stable keys are not in line yet; see the log");
}
```

After that each stable key holds the image that was active, so those readers serve it rather than an
original or a missing file. The objects under `media-revisions/` are then unused copies; keep
`safeMedia.privateDirectory`, which is the only place the originals are. If this step is skipped,
media whose cleanup is owed is served from its previous bytes. This covers the storage only: the
patches add migrations 092 and 093, and moving the database back to an unpatched EmDash is not
covered or tested.

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
