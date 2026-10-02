# image-optimizer

An EmDash plugin that reports images in the media library that are probably larger than they
need to be. It is **read-only for now**: it never changes, replaces or deletes media.

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
or its sandbox. It is **read-only like the registry edition**: it reports and never changes media. It
has the same plugin ID, `media:read` capability, storage, settings, routes, report page and widget,
so a site that switches between the editions keeps its scan results and settings.

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
  reporting in KB (default 50) and as a percentage of the file (default 20).

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
- Measuring real savings needs the image bytes and an encoder, which a sandboxed plugin does not have.
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
entry and `src/native.ts` the native one. The sandboxed entry must not import anything native-only,
and the native declarations must match `emdash-plugin.jsonc`; tests check both.

Releases are published by the `verco.app` Atmosphere account, pinned by its DID in
`emdash-plugin.jsonc`, so a publish from any other account fails.
