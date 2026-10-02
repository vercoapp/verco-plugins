# image-optimizer

A sandboxed EmDash plugin that reports images in the media library that are probably larger than they
need to be. It is **read-only**: it never changes, replaces or deletes media.

Status: in development, not published.

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
pnpm test        # Validate the manifest and run the tests in the sandbox test host.
pnpm typecheck
pnpm build       # Build the sandbox bundle with the EmDash plugin CLI.
```

The publisher in `emdash-plugin.jsonc` is a placeholder until the first release.
