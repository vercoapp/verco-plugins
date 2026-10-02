# image-optimizer

An EmDash plugin that reports images in the media library that are probably larger than they
need to be. It is **read-only for now**: as shipped, it does not change, replace or delete media.

Published in the EmDash plugin registry as a sandboxed plugin,
[`@verco.app/image-optimizer`](https://plugins.emdashcms.com/plugins/@verco.app/image-optimizer).
A [native edition](#native-edition) of the same report is in this package.

## Install

On an EmDash site with a [sandbox runner](https://docs.emdashcms.com/deployment/plugin-sandbox/)
configured, open **Registry** in the admin, search for "image optimizer" and install it. The consent
dialog lists one permission, `media:read`: metadata of ready media, without file contents. Then open
**Image report** and start a scan.

## Native edition

The same package also provides the report as a native plugin, for a site that cannot use the registry
or its sandbox. On every host it is **read-only like the registry edition** by default: it reports and
does not change media. It has the same plugin ID, storage, settings, routes, report page and widget, so
a site that switches between the editions keeps its scan results and settings. Where the registry
edition estimates savings from metadata, the native edition can
[measure them](#measured-savings-native-edition). It also contains
[apply and restore](#apply-and-restore-native-edition-pilot) and
[bulk runs](#bulk-runs-and-upload-automation-native-edition-pilot), which stay disabled on every host
until a hosted profile has been qualified.

A native plugin **runs without isolation, in the site process**. EmDash's capability checks still gate
what the plugin's context offers, but they are not a security boundary: the plugin's code has the same
access as the site. Prefer the registry edition where a sandbox runner is available.

Install the package in the site and register it in `astro.config.mjs`, in `plugins` (not `sandboxed`):

```js
import emdash from 'emdash/astro';
import { imageOptimizerPlugin } from 'image-optimizer';

export default defineConfig({
  integrations: [emdash({ plugins: [imageOptimizerPlugin()] })],
});
```

Register only one edition. EmDash does not reject two plugins with the same ID in its configuration,
so a site with both the native edition and the registry edition would run two copies of the hooks. If
you switch, remove one first.

The package is not published to npm yet. The native edition is tested against the plugin context
only, not yet on a running EmDash site.

### Measured savings (native edition)

With [Sharp](https://sharp.pixelplumbing.com/) installed in the site (`sharp` is an optional peer
dependency, tested with 0.35.4), a native scan **measures** each saving instead of estimating it. It
reads each image's bytes, re-encodes them locally in the same format and at the same dimensions with
the configured preset and metadata policy, records the output size, and discards the output. The
scan never writes media: it only reads. Without Sharp, or on a
host that does not grant byte access, the native edition estimates from metadata like the registry
edition.

The native edition declares one capability more than the registry edition on published EmDash,
`media:bytes:read`, to read image bytes; there it cannot write media. On the patched host it also
declares `media:bytes:replace`, used only by [apply and restore](#apply-and-restore-native-edition-pilot).

- **Results.** Each stored result is marked `measured` or `estimated`, and the report labels savings
  accordingly. A measured image is listed when its saving reaches both thresholds in the settings
  (default 50 KB and 20%). Images uploaded while or after a measured scan runs are estimated on upload,
  labelled as estimates, and measured by the next scan.
- **Skips** come from the decoded image: not JPEG, PNG or WebP by content (GIF, SVG, AVIF and others are
  skipped by type without being read), malformed, animated, over the byte or pixel limit, a colour
  profile or bit depth that re-encoding would change, or metadata the GPS setting cannot be applied to.
- **Failures.** A busy, crashed or interrupted encode is tried again in a later tick, up to three
  attempts; other errors, such as a timeout, are recorded as failures and listed in the report.
- **Pace.** Images are encoded one at a time. A tick handles at most 20 images and starts no new image
  after 20 seconds, so it finishes well inside the one-minute schedule and leaves the site process its
  other cores. That is far slower than estimating: at the cap, 10,000 images take more than eight
  hours.

**Presets** (setting *Encoding preset*). The report lists the exact Sharp options of the chosen preset.

| Preset | JPEG | WebP (lossy) | PNG and lossless WebP |
| --- | --- | --- | --- |
| `balanced` (default) | quality 80, 4:2:0, mozjpeg defaults | quality 80 | lossless |
| `high-fidelity` | quality 90, 4:4:4, mozjpeg defaults | quality 90 | lossless |

The qualities are starting points, not yet qualified on a photograph corpus. Palette quantization and
lossless JPEG are not available. Orientation, alpha and ICC profiles are kept.

**Metadata** (setting *Remove GPS position*, off by default). Metadata is kept, including copyright.
With the setting on, the measurement removes GPS position from EXIF and XMP; the stored file is not
changed.

**Sample.** The report has a *Sample* button on each listed image and a *Sample top result* button.
A sample processes one image with the current settings and shows the byte counts, dimensions and
format before and after, the time taken and the encoder options. It changes nothing: neither the
media nor the scan results. It shows numbers only, no images: Block Kit shows an image only by URL,
and the processed output is never stored, so it has none.

### Apply and restore (native edition, pilot)

The native edition can replace one image in place with its optimized output, and put the original
back. **Both are disabled on every host.** They need the
[patched EmDash host](https://github.com/vercoapp/verco-plugins/blob/main/host/emdash/patches/README.md)
with `safeMedia` configured, which gives native plugins that declare `media:bytes:replace` a fenced
replace and restore. Published EmDash has no such access: there the plugin does not declare the
capability and stays read-only. Even on the patched host, the plugin allows apply and restore only
when the host's reported profile (runtime, database, storage, locks) is on a list of qualified
profiles, and that list is empty: no profile has passed qualification yet. Elsewhere the report says
why apply and restore are unavailable, and the routes answer `unavailable` and change nothing.

What has been exercised: the plugin's own tests against an in-memory model of the host, and an
end-to-end test against the patched host's runtime on Node with SQLite and local storage (run when the
pilot checkout from `pnpm host:pilot` is present). Nothing else: not object storage, D1, Cloudflare or
several processes, and not a hosted site.

For testing only, a site operator can allow a profile explicitly. This is **unsupported** until that
profile is qualified, and is at the operator's risk:

```js
imageOptimizerPlugin({
  qualifiedProfiles: [{ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' }],
});
```

- **Apply** (button *Apply* per result in the report, or `POST .../apply` with `{ "mediaId": ... }`)
  reads the image's active revision and bytes, re-encodes them with the current preset and metadata
  policy, and submits the output only when the saving reaches both thresholds in the settings, and never
  less than 10 KiB and 5%. The host publishes it only if the image is still the revision that was read,
  in the same format and at the same dimensions; if an editor changed the image meanwhile, nothing is
  published and the report says so. The media item keeps its ID, file address, alt text, caption and
  focal point, so content that references it now shows the smaller file. Applying again with the same
  settings changes nothing.
- **What is kept.** The host keeps the exact bytes of every replaced original in its private store
  (`safeMedia.privateDirectory`), outside public storage, and keeps a record of each operation. The
  plugin keeps only a small record per optimized image (sizes, preset, operation) in its key-value
  store, never image bytes. Retained originals use storage; nothing removes them yet.
- **Restore** (button *Restore* in the report's *Optimized by this plugin* list, or `POST .../restore`)
  puts back the original that this plugin's optimization replaced, byte for byte: the plugin checks
  that the host's receipt names the original's SHA-256 digest. It refuses when the image was changed by
  someone else after the optimization, since restoring would overwrite that change, and it does not
  restore other callers' replacements. The host's own restore keeps working without the plugin.
- **Changing the preset or GPS setting** and applying again starts from the original, never from the
  earlier output. The host offers no way to read a retained original without publishing it, so the
  plugin first restores the original (fenced like any restore), then re-encodes the restored bytes,
  checked against the original's digest. If the new output does not save enough, the original stays.
- **Retries.** Each host operation has an ID derived from the media ID, the source revision, the
  settings that determine the output, and the processor version, so retrying after a lost response
  returns the host's earlier receipt instead of changing the image twice. The output waits for the
  host in a private staging directory (by default under the system temporary directory, one per site;
  option `stagingDirectory`), so a retry after the site process stopped submits the same bytes. Staged
  files are removed once the host's outcome is final, and any older than a day are removed on the next
  apply.

Both routes accept POST only and require the `plugins:manage` permission.

### Bulk runs and upload automation (native edition, pilot)

Bulk runs apply or restore many images through the same fenced path as the buttons above. **They are
disabled wherever apply and restore are**, which is every host until a hosted profile has been
qualified; the report then shows no bulk controls, and the routes refuse to start a run. What has been
exercised is the same as for apply and restore, plus a 1,000-image run against the in-memory model of
the host with restarts, overlapping workers, editor changes, deletions and lost responses.

- **Starting a run.** The report offers *Optimize all measured images* (every result a measured scan
  listed), *Optimize the N listed* (the results on the page shown) and *Restore all originals* (every
  image this plugin optimized). `POST .../bulk-start` takes `{ "kind": "apply" | "restore",
  "mediaIds": [...] }`, up to 1,000 IDs; without `mediaIds` it takes the same sets as the buttons. Only
  measured savings start an apply: an estimate from metadata is not a reason to change a file.
- **One run at a time,** never beside a scan: a run does not start while a scan runs, a scan does not
  start while a run is active, and a run that meets a scan waits for it.
- **Pace.** Runs continue in the background with the scheduled task, whether or not the report is open:
  one image at a time, at most 20 per tick and no new image after 20 seconds, as for measured scans.
- **Durable state.** Each run and each of its images has a record in the plugin's storage (collections
  `runs` and `items`, native edition only), with the image's state: waiting, processing, ready to
  submit, submitting, waiting to retry, then optimized, restored, skipped, conflict or failed. A worker
  claims an image with a conditional write and holds it under a five-minute lease; every later step is
  a conditional write too, so a worker whose lease expired and was taken over cannot submit. After a
  restart, the run continues from these records, and an image whose worker stopped mid-submission is
  completed from the host's record of the operation, not submitted again.
- **Controls** (report buttons, or `POST .../bulk-pause`, `bulk-resume`, `bulk-cancel`, `bulk-retry`,
  `bulk-status`). Pause and cancel stop new work between images; an image already being submitted
  finishes. Output processed while the run was paused waits in staging and is submitted on resume.
  Cancel skips the images not yet submitted and leaves the optimized ones optimized. Retry queues the
  failed images of the last run again. A restore run reports each image as restored, failed with a
  missing original, or a conflict when the image changed since it was optimized.
- **Upload automation** (setting *Optimize new uploads*, off by default). Each new upload is queued,
  never processed during the upload, and an upload succeeds whatever happens to its optimization. A
  queue in the background works through uploads when no run is active. Once an hour, and on the
  report's *Find missed uploads* button, a reconciliation pass looks through media uploaded since
  automation was switched on and queues what the upload hook missed; an image is queued at most once.
  Switching the setting off stops queueing; switching it on again starts from that moment. Where the
  host does not allow changes, nothing is queued.
- **Accounting.** The report keeps three numbers apart. *Source reduction (gross)*: how much smaller
  the files of the images optimized now are. *Originals retained*: the files the host keeps because of
  this plugin's operations, the originals that applies replaced and the optimized files that restores
  replaced, counted once per distinct file. *Net storage change*: retained bytes minus the reduction.
  While originals are retained this is an **increase**: an optimized image costs its new file on top of
  its original. The reduction makes pages lighter to deliver; it is not a storage saving. The numbers
  come from the host's receipts as the plugin recorded them; the host can prune originals without the
  plugin knowing, which this does not show. After an apply or restore, the image's scan result and the
  scan's totals are updated, so the report does not keep offering a saving already made.

**Limits of the local processor.** Inputs up to 24 megapixels and 50 MiB; EmDash lets a plugin read at
most 16 MiB of a file, so larger files are skipped. One encode is killed after 60 seconds. These
limits, and the tick bounds above, come from measurements on a development machine (Apple M1 Pro,
synthetic noise images, worst case about 12 seconds and 1.5 GB at 24 MP) and are provisional until
measured on hosting hardware.

## Why it is read-only

Optimizing an image means replacing its file, and EmDash has no way yet for a plugin to do that
safely:

- Replacing overwrites the file at the same storage key. The original is gone, so a bad result cannot
  be undone.
- An editor's change made at the same moment can be overwritten, or overwrite the optimized file,
  without either side noticing.
- Sandboxed plugins cannot replace a file at all: their media access covers reading, uploading a new
  item, deleting, and editing alt text, captions and focal points.

So the plugin reports and leaves every image as it is.

**In-place optimization is planned.** It will be added once EmDash can replace an image while
keeping its original and refusing conflicting changes. That support has been
[proposed to the EmDash project](https://github.com/emdash-cms/emdash/discussions/3740); this
repository's [host patches](https://github.com/vercoapp/verco-plugins/blob/main/host/emdash/patches/README.md) are a working pilot of it.

## What it checks

The scan reads only media metadata (type, byte size and dimensions) through the `media:read`
capability. It does not read image bytes, so every saving it reports is an **estimate**.

| Finding | Meaning |
| --- | --- |
| `oversized-dimensions` | The longest edge exceeds the configured maximum (default 2560 px). |
| `heavy-encoding` | A JPEG, WebP or AVIF file uses more bytes per pixel than a typical web encoding. |
| `possible-photo-as-png` | A PNG dense enough to suggest a photograph. Advisory, no saving estimated. |
| `uncompressed-format` | A BMP or TIFF file. Advisory, no saving estimated. |

Each estimate records its basis: `resize` (scaling down only) or `resize-and-reencode` (also assuming a
typical encoding density for the same format). For PNG, BMP and TIFF only the resize is estimated. A
finding is reported only when the estimated saving reaches both the byte and the ratio thresholds
(default 50 KB and 20%); the advisory findings are always reported.

GIF, SVG, HEIC and other image types are skipped, as are items with missing or invalid size or
dimensions.

## In the admin

- **Image report** (a plugin page): totals, the images that could be smaller ordered by estimated
  saving, and the skipped images with the reason each was skipped. Start a scan from here. While a
  scan runs, the page shows how many images it has scanned and when it last made progress; refresh
  to update it.
- **Image savings** (a dashboard widget): the estimated saving and the number of images to review.
- **Settings**: the largest useful edge in pixels (default 2560), and the smallest saving worth
  reporting in KB (default 50) and as a percentage of the file (default 20). The native edition adds
  the encoding preset and GPS removal for [measured savings](#measured-savings-native-edition), and
  [upload automation](#bulk-runs-and-upload-automation-native-edition-pilot) (off by default).

Opening the report and starting a scan require the `plugins:manage` permission. The page and widget
are in English; numbers follow the administrator's locale.

## How a scan runs

`POST /_emdash/api/plugins/image-optimizer/scan-start`, or the button on the report page, starts a
scan unless one is already running. The work happens in a task that runs every minute and handles up
to 300 images each time, so results appear within about a minute and a library of 10,000 images takes
about half an hour. The task is cancelled when the scan finishes.
`GET .../scan-status` returns the progress and totals. Both routes require the `plugins:manage`
permission.

The scan reads the library newest first and stores one result per image. Images uploaded after a
scan starts are scanned on upload instead and added to the totals. When the sweep finishes, results
for media deleted since the previous scan are removed. Results for media deleted after that remain
until the next scan.

A scan keeps the settings it started with.

## Calibration

The densities the scan assumes were measured on the Kodak suite (24 photographs, 768 × 512)
re-encoded with Sharp 0.35.4 at its default qualities. Each value is the 75th percentile of what
those photographs needed (JPEG 0.24, WebP 0.21, AVIF 0.10 bytes per pixel), and a resized image is
assumed to keep its area ratio to the power 0.9 of its bytes. Against the same photographs, with
the 50 KB minimum turned off because they are small:

| | JPEG | WebP | AVIF |
| --- | --- | --- | --- |
| Heavy uploads reported (quality 95, AVIF 80) | 21 of 24 | 20 of 24 | 24 of 24 |
| Already-optimized uploads reported | 1 of 24 | 1 of 24 | 1 of 24 |
| Estimated ÷ actual saving, median (range) | 0.79 (0.47–1.30) | 0.76 (0.38–1.42) | 0.78 (0.32–1.20) |

So estimates usually understate the saving, and one image in a few is overstated by up to about
40%. Photographs saved as PNG measured 1.34 to 2.26 bytes per pixel and flat graphics 0.03 to 0.06,
well either side of the 1.0 used for `possible-photo-as-png`.

To repeat or extend this, `pnpm calibrate:fetch-kodak` downloads the suite into the ignored
`.calibration/` directory and `pnpm calibrate [directory]` measures any directory of lossless
photographs.

Each plugin invocation makes at most 10 calls to EmDash: on Cloudflare every storage, KV, settings,
media, cron and log call counts toward the sandbox's subrequest limit, which is 10 by default. That
limit, not processing time, is why a tick handles 300 images. The tests check the count for every
hook and route, because neither the Node runner nor the test hosts enforce it.

## Limits

- The densities are percentiles over one small corpus, not a model of image content. A detailed
  photograph and a simple one of the same size and type get the same estimate. Graphics and
  screenshots saved as JPEG or WebP are not distinguished from photographs.
- Larger photographs need fewer bytes per pixel than the calibration images, so for them the scan
  errs towards reporting less.
- Measuring real savings needs the image bytes and an encoder, which a sandboxed plugin does not have;
  only the native edition measures.
- An upload made at the moment a scan starts can be counted twice in the totals. The stored results
  are not affected.
- The report has no link to each image in the media library: Block Kit links can target content,
  plugin pages and settings, but not media items.
- Tested in the EmDash plugin test hosts only, not yet on a deployed Node or Cloudflare site, and the
  report has not been tried with users. The 50 ms CPU limit per invocation on Cloudflare has not been
  measured.

## Development

```sh
pnpm test        # Validate the manifest and run the tests: the sandbox test host, and both editions' handlers.
pnpm typecheck
pnpm build       # Build the sandbox bundle with the EmDash plugin CLI, then the native entry with Vite.
```

Both editions are wrappers over the shared code in `src/handlers.ts`: `src/plugin.ts` is the sandboxed
entry and `src/native.ts` the native one, which adds the measured scan and sample (`src/measure.ts`)
over the local processor (`src/processor/`), apply and restore (`src/mutations.ts`, with
`src/staging.ts` and the media host adapter in `packages/media-host-adapter`), and bulk runs and upload
automation (`src/bulk.ts`). The tests in
`tests/pilot/` run the native edition in the patched host's runtime; they need the pilot checkout
(`pnpm host:pilot`, or `EMDASH_PILOT_DIR` pointing at one) and are skipped without it. The sandboxed entry must not import anything native-only,
and the native declarations must match `emdash-plugin.jsonc` apart from the byte-read capability, the
three native settings and the two storage collections of bulk runs; tests check both.

Releases are published by the `verco.app` Atmosphere account, pinned by its DID in
`emdash-plugin.jsonc`, so a publish from any other account fails.
