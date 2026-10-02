# image-optimizer

A sandboxed EmDash plugin that reports images in the media library that are probably larger than they
need to be. It is **read-only**: it never changes, replaces or deletes media.

Status: in development, not published. The scanner and the scan job exist; the admin report page and
the settings form do not yet.

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
(default 50 KiB and 20%); the advisory findings are always reported.

GIF, SVG, HEIC and other image types are skipped, as are items with missing or invalid size or
dimensions.

## How a scan runs

`POST /_emdash/api/plugins/image-optimizer/scan-start` starts a scan, unless one is already running,
and processes the first 500 images straight away. Larger libraries continue from a task that runs
every minute and handles another 500 each time; it is cancelled when the scan finishes.
`GET .../scan-status` returns the progress and totals. Both routes require the `plugins:manage`
permission.

The scan reads the library newest first and stores one result per image. Images uploaded after a
scan starts are scanned on upload instead and added to the totals. When the sweep finishes, results
for media deleted since the previous scan are removed. Results for media deleted after that remain
until the next scan.

Thresholds come from the plugin settings `maxDimension`, `minSavingsBytes` and `minSavingsRatio`. A
scan keeps the values it started with.

## Limits

- The typical densities behind `heavy-encoding` are heuristics for photographic content, not
  measurements of an encoder. Graphics, screenshots and already-optimized files can be misjudged.
- Measuring real savings needs the image bytes and an encoder, which a sandboxed plugin does not have.
- An upload made at the moment a scan starts can be counted twice in the totals. The stored results
  are not affected.
- Tested in the EmDash plugin test hosts only, not yet on a deployed Node or Cloudflare site.

## Development

```sh
pnpm test        # Validate the manifest and run the tests in the sandbox test host.
pnpm typecheck
pnpm build       # Build the sandbox bundle with the EmDash plugin CLI.
```

The publisher and security contact in `emdash-plugin.jsonc` are placeholders until the first release.
