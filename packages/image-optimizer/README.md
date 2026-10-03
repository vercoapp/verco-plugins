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
or its sandbox. On published EmDash, and on every host except one, it is **read-only like the registry
edition**: it reports and does not change media. It has the same plugin ID, storage, settings, routes,
report page and widget, so a site that switches between the editions keeps its scan results and
settings. Where the registry edition estimates savings from metadata, the native edition can
[measure them](#measured-savings-native-edition). It also contains
[apply and restore](#apply-and-restore-native-edition-pilot) and
[bulk runs](#bulk-runs-and-upload-automation-native-edition-pilot). These are available on one host
profile only, as a pilot: EmDash built with this repository's host patches, on Node with SQLite and
local file storage, one process per site, media served only through the site. Everywhere else they
are refused and the plugin stays read-only.

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

The package is not published to npm yet. Besides its tests against the plugin context, the native
edition has run on disposable EmDash sites built from the patched host, on the hosted profile (Node
on the host, one systemd service per site) and earlier in a Docker container; see
[Hosted profile](#hosted-profile-node-on-the-host-one-systemd-service-per-site-native-edition-pilot).

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
  after 15 seconds, so even a tick whose last image runs to the 40-second encode limit ends inside the
  one-minute schedule, and the site process keeps its other cores. That is far slower than estimating: at the cap, 10,000 images take more than eight
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
back. **Both are available on one host profile and refused everywhere else.** They need the
[patched EmDash host](https://github.com/vercoapp/verco-plugins/blob/main/host/emdash/patches/README.md)
with `safeMedia` configured, which gives native plugins that declare `media:bytes:replace` a fenced
replace and restore. Published EmDash has no such access: there the plugin does not declare the
capability and stays read-only. On the patched host, the plugin allows apply and restore only when
the host's reported profile (runtime, database, storage, locks) is, field for field, on the list of
qualified profiles in `packages/media-host-adapter`. That list has one entry:

```js
{ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' }
```

that is, a Node process with SQLite and local file storage whose safe-media locks live in that one
process. On a host reporting exactly this, apply, restore and bulk runs are on with no option set.
On any other profile (object storage, D1, another runtime, another lock scheme, a field more or
less), on an unknown protocol version, or when discovery fails, the report says why apply and restore
are unavailable, and the routes answer `unavailable` and change nothing.

**What the host's profile does not tell the plugin**, and the operator therefore has to ensure:

- **One process per site.** The locks are in the process; two processes on the same data can
  interleave replacements. The host reports `locks: 'in-process'` from each of them.
- **Media served only through the site.** Originals stay in the uploads directory at their public
  keys; anything serving that directory directly would serve them.

Both are part of the
[hosted profile](#hosted-profile-node-on-the-host-one-systemd-service-per-site-native-edition-pilot)
that was run.

**This is a pilot.** The profile was exercised on one VPS, with images generated for the run, on a
disposable site: no real users, content or traffic. The host patches are a pilot too, pinned to one
EmDash commit, not a supported version range. Keep backups (see
[Backup](#backup)), and expect to rebuild the host for every EmDash upgrade.

What has been exercised: the plugin's own tests against an in-memory model of the host, and an
end-to-end test against the patched host's runtime on Node with SQLite and local storage (run when the
pilot checkout from `pnpm host:pilot` is present), and
[site runs](#hosted-profile-node-on-the-host-one-systemd-service-per-site-native-edition-pilot) on
disposable sites driven over HTTP: one as a systemd service on the host, one in a Docker container.
Nothing else: not object storage, D1, Cloudflare or several processes, and not a site with real users
or content.

A site operator can replace the list. An empty list keeps the plugin read-only on every host:

```js
imageOptimizerPlugin({ qualifiedProfiles: [] });
```

Listing any other profile allows apply and restore on a host reporting it. That is **unsupported**
and at the operator's risk: nothing but the profile above has been exercised.

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
  earlier output. The plugin reads the retained original privately from the host (no URL, nothing
  published), checks it against the original's SHA-256 digest and size, re-encodes it, and replaces
  the optimized image with the new output, fenced on the optimized revision. The original is never
  made active on the way, and the host retains the replaced optimized file as well. If the new output
  does not save enough, the optimized image stays and nothing is recorded. On a host without that
  private read, or when the host refuses it (the original is no longer kept, its file is missing or
  damaged, or it is over the read limit of 16 MiB), nothing changes and the outcome says why: the
  plugin neither re-encodes its own lossy output nor restores the original to read it. Restore the
  image first to optimize it from the original there. A read the host could not do just now is
  retried like other temporary failures.
- **Retries.** Each host operation has an ID derived from the media ID, the source revision, the
  settings that determine the output, and the processor version (and, for a re-optimization, which is
  told apart from a first optimization, the original's digest), so retrying after a lost response
  returns the host's earlier receipt instead of changing the image twice. The output waits for the
  host in a private staging directory (by default under the system temporary directory, one per site;
  option `stagingDirectory`), so a retry after the site process stopped submits the same bytes. Staged
  files are removed once the host's outcome is final, and any older than a day are removed on the next
  apply.

Both routes accept POST only and require the `plugins:manage` permission.

### Bulk runs and upload automation (native edition, pilot)

Bulk runs apply or restore many images through the same fenced path as the buttons above. **They are
available only where apply and restore are**, which is the one qualified host profile; elsewhere the
report shows no bulk controls, and the routes refuse to start a run. What has been
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
  and re-optimizations replaced, counted once per distinct file. *Net storage change*: retained bytes minus the reduction.
  While originals are retained this is an **increase**: an optimized image costs its new file on top of
  its original. The reduction makes pages lighter to deliver; it is not a storage saving. The numbers
  come from the host's receipts as the plugin recorded them; the host can prune originals without the
  plugin knowing, which this does not show. After an apply or restore, the image's scan result and the
  scan's totals are updated, so the report does not keep offering a saving already made.

**Limits of the local processor.** Inputs up to 24 megapixels and 16 MiB (EmDash lets a plugin read
at most 16 MiB of a file, so larger files are skipped); lossless WebP up to 12 megapixels. One encode
is killed after 40 seconds, and at most two run at once, within a budget of 24 million decoded pixels
in flight (a lossless WebP pixel counts twice). These came from measurements on one VPS under a
container cap, not from a guarantee: see [Processor limits](#processor-limits). The same limits held
under the hosted profile's service caps in one scan of images near them, without an out-of-memory kill.

### Hosted profile: Node on the host, one systemd service per site (native edition, pilot)

The hosted profile for sites is a Node process on the host (no container), run as a systemd service
of its own under its own Unix user, with its own SQLite database, uploads, private originals and
staging directories (owned by that user, mode 0700), memory and CPU caps on the service, bound to
127.0.0.1 behind a reverse proxy, **exactly one process per site**.

`qualification/qualify-site.mjs --runner systemd` builds a disposable EmDash site from the patched
host and runs it this way, as a transient systemd service, then drives the native edition over HTTP
the way the admin does. The last clean run is recorded in
[`qualification/site-host-latest.json`](qualification/site-host-latest.json). What the host reports on
this profile is the one entry of `QUALIFIED_HOST_PROFILES` in `packages/media-host-adapter`, so apply,
restore and bulk runs are **on by default** here; the run registers the plugin with no
`qualifiedProfiles` option for everything after its first check. The list rests on this run and the
tests named above, nothing more: one VPS, generated images, no real site.

**The profile as run.** The pinned EmDash commit with host patches 0001 to 0009 (the git tree of 0009
is checked), the `emdash` package built from it and every other EmDash package at the pinned
published version, Astro 7.3.2 with `@astrojs/node` 11.1.5 (standalone), SQLite through `node:sqlite`,
local storage, `safeMedia` with a private directory outside the uploads and public directories, Astro
sessions in the data directory, Sharp 0.35.4 (libvips 8.18.6). One Node 22.16.0 process from the
official Linux x64 build, on a 4 vCPU AMD EPYC VPS with 8 GB of memory running Debian 13 (glibc 2.41).
The site was installed and built in a Debian 12 container and run on the host; Sharp's prebuilt
binaries loaded there. The host reports this profile as
`{ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' }`, the same as the
Docker run below. The service had these properties:

- Caps: `MemoryMax=3G`, `MemorySwapMax=0`, `CPUQuota=200%`, and `OOMPolicy=continue` (see the memory
  check below).
- Sandbox: `ProtectSystem=strict` with `ReadWritePaths=` the data directory only (the site's code is
  read-only to it), `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectHome`,
  `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`,
  `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`, `RestrictSUIDSGID`, `RestrictRealtime`,
  `RestrictNamespaces`, `LockPersonality`, `SystemCallArchitectures=native`, an empty
  `CapabilityBoundingSet`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` (without
  netlink, `os.networkInterfaces()` fails and requests error), `IPAddressDeny=any` with
  `IPAddressAllow=localhost`, and `UMask=0077`. `MemoryDenyWriteExecute` cannot be used: V8 needs
  writable executable memory.

**What the run checks.** Every image is generated by Sharp, and the admin and editor sign in with
software passkeys made for the run.

- With an empty qualified list given explicitly, the plugin reports the host's profile and stays
  read-only; apply and bulk runs refuse and change nothing.
- With no list given, the plugin as shipped: the host's reported profile is exactly the qualified
  one, and the report offers apply and restore. Then a measured scan of 11 images; a sample that changes no row or
  file; apply of one image, after which its unchanged URL serves the new bytes, its ID, storage key,
  alt text, caption and focal point are kept, and the host's operation is fenced on the baseline
  revision; the original is in the private store and none of 13 URL probes (its key, encoded and
  traversal paths, revision keys, query parameters, the transformed endpoint) serves it; restore
  serves the original byte for byte; a preset change re-optimizes from the privately read original
  with a single fenced replace and no restore; a bulk apply of three images and a batch restore,
  byte-exact.
- Authorization: the sample, apply, restore, bulk-start (apply and restore), bulk-retry,
  bulk-reconcile and scan-start routes, each without a session (401), as an editor without
  `plugins:manage` (403), as the admin without the `X-EmDash-Request` header (403), as the admin from
  another origin without it (403) and with an invalid bearer token (401). Every one of the 40 requests
  left the database rows and files unchanged.
- Lifecycle: a run paused before an upgrade (the plugin rebuilt under another version) is still paused
  after it and through a scheduler interval, with its images untouched, and completes on resume;
  scan results, settings and run records are kept. Disabling the plugin stops an active run while
  every image keeps serving; enabling it again completes the run. The sandboxed edition registered
  instead has no apply or bulk routes (404) and its report offers neither. With the plugin removed
  from the site, every image serves its active bytes; the host's recovery entry point, run as the
  site user with the site stopped, then restores an optimized image byte for byte. Registered again,
  the plugin finds its data, does not claim the host's restore (`nothing-to-restore`), and restores
  another image it optimized.

And, for this profile:

- **The caps are in effect.** On each of the eight starts, the unit's cgroup has `memory.max`
  3221225472, `memory.swap.max` 0 and `cpu.max` `200000 100000`, and the one site server process runs
  in that cgroup, as the site user, as the unit's main process.
- **The processor's workers run inside the unit.** The site's processes are found from `/proc`, not
  from the unit: during the measured scan all 11 workers, and during the scan below all 15, were in
  the unit's cgroup.
- **No out-of-memory kill under the caps.** A measured scan of images near the processor limits
  (23.9 MP JPEG of 10.4 MiB, 12 MP lossy WebP, 12 MP lossless WebP of 14.8 MiB), with a sample of the
  largest started beside it, ran with the shipped [processor limits](#processor-limits). All three
  were measured. The sample was refused as busy: the pixel budget did not admit it beside the
  scan's 24 MP encode, so two encodes never ran at once in this run. The unit peaked at 705 MiB of its
  3 GiB, and `memory.events` showed no `oom` or `oom_kill`. The same was read from every unit just
  before it stopped: none of the eight reached its limit.
- **Site data belongs to the site user alone.** After the uploads, after the first apply and at the
  end of the run, every entry under the data directory is owned by the site user; the data, uploads,
  private, staging and sessions directories are 0700, the database 0600, and no file (the
  database's `-wal` and `-shm` included) has group or other access. As `nobody`, reading the
  database, the directories, a retained original or an uploaded file each failed with `EACCES`.
- **One process per site.** While the site runs, the runner refuses to start it again, and
  `systemd-run` refuses a second unit of the same name; the site keeps its single process.

The new checks were confirmed by breaking each one on purpose, and each run then failed:
- **No memory cap:** without `MemoryMax`, the unit showed `memory.max` `max`.
- **Private directory at 0755:** the mode check failed. With every data directory at 0755 and the
  mode check removed, the read as `nobody` succeeded and failed the run.
- **Site server moved out of the unit's cgroup:** the server check failed. With that check removed,
  the workers check found the server and its workers outside the unit.
- **Cap lowered to 600 MiB:** the kernel killed a worker on each of three ticks. Under the default
  `OOMPolicy=stop`, systemd stopped the whole site at the first kill, which is why the service uses
  `OOMPolicy=continue`. With it, the site kept serving and the `memory.events` check failed the run.
- **Runner's one-process guard removed:** the second start reached `systemd-run`, which refused the
  duplicate unit name, and the check, which expects the runner's own refusal, failed.

**Delivery freshness.** After each apply, restore and re-optimization, the first request to the
image's URL (`/_emdash/api/media/file/<key>`) and to its transformed URL (`/_image?href=...&w=320&f=png`)
already served the new content: no stale response, the direct URL within 11 ms and the transformed
one within 25 ms of the route answering (the transform included). Both answer
`Cache-Control: public, max-age=0, must-revalidate` without an ETag. That bounds the site itself only:
a CDN or proxy in front that ignores these headers, and pages prerendered at build time, keep the old
image until they are purged or rebuilt, which this run does not cover.

**The original stays in the uploads directory.** When the host first replaces an image, it records
the uploaded file, at its storage key, as the image's baseline revision and keeps it there; it also
copies it to the private store. The file route resolves the key to the active revision, so the
original is not served through EmDash, but anything that serves the uploads directory directly (a web
server or proxy mounting it, a public bucket) would serve originals. Serve media only through the
site; on this profile the data directory's mode 0700 also keeps a proxy running as another user from
reading it.

Not covered: a reverse proxy in front (the recorded run talks to the site's port directly; see
below), a persistent unit with `Restart=` and boot ordering (the run uses transient units), several
sites on one host, real users or content.

**Through a reverse proxy.** With `--proxy caddy` the script starts a throwaway
[Caddy](https://caddyserver.com/) on 127.0.0.1 in front of the site (a `caddy` binary, or with
`--proxy-image <image>` a container on the host's network, removed when it stops) and sends every
request of the run to the proxy; the site's URL and the passkeys' origin are the proxy's. Besides
the whole checklist it checks that the proxy's adapted configuration listens on loopback only, has
no handler but a reverse proxy to the site, no file server, no file-system root and no admin
endpoint; that the proxy answers 502, not content, while the site is down; and that every response
measured for freshness carries the proxy's `Via` header. It writes
`qualification/site-host-proxy-latest.json`. **No run through a proxy is recorded yet.**

In both forms the run requests the stored copies of an original (in the uploads directory and in the
private store) at their file paths under likely static prefixes (`/uploads/...`, `/data/...`,
`/media/...`, `/private/...` and others) and at their absolute paths, and fails if any answer is the
original; and the authorization matrix includes a cross-origin request with forged
`X-Forwarded-Host`, `X-Forwarded-Proto` and `Forwarded` headers. These two additions are in the
script but not yet in the recorded evidence.

To repeat the run, as root on the host, from a checkout carrying the host patches, with the site
user created (`useradd --system --no-create-home --shell /usr/sbin/nologin <user>`):

```sh
pnpm host:checkout && pnpm host:pilot
(cd .upstream/emdash-pilot && npx pnpm@11.9.0 install --frozen-lockfile --ignore-scripts)
node packages/image-optimizer/qualification/qualify-site.mjs \
  --runner systemd --site-user <user> --work <directory the user can traverse> \
  --pilot .upstream/emdash-pilot --patch-manifest host/emdash/patches/patches.json
```

`--build-wrapper <executable>` runs the build steps (git, pnpm, npm, tar, astro) elsewhere, for
example in a container, as `<executable> <directory> env <NAME=VALUE...> <command...>`. The build
environment must see the work directory at the same real path, since Astro records it in the build
(a symlink does not do). `--memory-max` and `--cpu-quota` change the caps. It takes about ten minutes,
leaves the site stopped and its unit gone, and writes `qualification/site-host-latest.json` only when
every check passed and the checkout has no uncommitted change; the evidence names the commit.

#### Earlier run on a Docker profile

Before the runtime was decided, the same checklist ran with the site as a child process in a Docker
container capped at 2 CPUs and 3 GiB (memory and swap) on the same VPS, without the service sandbox
or a separate site user. It passed and is kept as additional evidence in
[`qualification/site-latest.json`](qualification/site-latest.json) (the default `--runner process`):
first responses were fresh within 16 ms direct and 28 ms transformed. It predates the qualified list:
the plugin was given the profile explicitly. That run also confirmed the
script by breaking it: sending the CSRF header for the caller that should lack it, ignoring the
response status so that only the state comparison could catch an apply, and not pausing the run
before the upgrade each made the run fail.

#### Installing on this profile (pilot)

1. Build the patched host: `pnpm host:checkout`, `pnpm host:pilot` (from a checkout carrying the
   patches), install the pilot as above, then `npx pnpm@11.9.0 build` and
   `npx pnpm@11.9.0 pack` in `.upstream/emdash-pilot/packages/core`.
2. In the site, install that `emdash` tarball, the other EmDash packages it names at their pinned
   versions, Sharp 0.35.4, and this package (`pnpm build` here, then `npm pack`). Build the site
   (`astro build`) where it will run, or at the same real path.
3. Configure the site as `qualification/site/astro.config.mjs` does: `siteUrl`, SQLite, local storage,
   `safeMedia: { privateDirectory }` with the private directory outside both the uploads and the
   public directories, and Astro's session driver pointed into the data directory
   (`sessionDrivers.fsLite({ base })`), since the code directory is read-only to the service.
4. Register `imageOptimizerPlugin({ stagingDirectory })`, with the staging directory in the data
   directory. Apply and restore are then on, because the host reports the qualified profile; pass
   `qualifiedProfiles: []` as well to keep the plugin read-only.
5. Create the site user and its data directory, owned by it and closed to everyone else:

   ```sh
   useradd --system --no-create-home --shell /usr/sbin/nologin site-example
   install -d -m 0700 -o site-example -g site-example /srv/site-example/data
   for d in uploads private staging sessions; do
     install -d -m 0700 -o site-example -g site-example "/srv/site-example/data/$d"
   done
   ```

   The code (`/srv/site-example/app` here) stays owned by root and readable by the site user.
6. Run it as one service. A minimal definition, with the properties the run used (`Restart=` and the
   `[Install]` section were not part of the run, which used transient units):

   ```ini
   # /etc/systemd/system/site-example.service
   [Unit]
   Description=EmDash site (example)
   After=network.target

   [Service]
   User=site-example
   Group=site-example
   WorkingDirectory=/srv/site-example/app
   Environment=HOST=127.0.0.1 PORT=4321 NODE_ENV=production
   ExecStart=/opt/node-v22.16.0/bin/node dist/server/entry.mjs
   Restart=on-failure
   TimeoutStopSec=30

   MemoryMax=3G
   MemorySwapMax=0
   CPUQuota=200%
   OOMPolicy=continue

   UMask=0077
   ProtectSystem=strict
   ReadWritePaths=/srv/site-example/data
   NoNewPrivileges=yes
   PrivateTmp=yes
   PrivateDevices=yes
   ProtectHome=yes
   ProtectKernelTunables=yes
   ProtectKernelModules=yes
   ProtectKernelLogs=yes
   ProtectControlGroups=yes
   ProtectClock=yes
   ProtectHostname=yes
   ProtectProc=invisible
   RestrictSUIDSGID=yes
   RestrictRealtime=yes
   RestrictNamespaces=yes
   LockPersonality=yes
   SystemCallArchitectures=native
   CapabilityBoundingSet=
   RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
   IPAddressDeny=any
   IPAddressAllow=localhost

   [Install]
   WantedBy=multi-user.target
   ```

   `IPAddressDeny=any` also blocks outbound connections from the site; drop it if the site needs any.
   The processor limits were measured for 3 GiB and two CPUs; with other caps, measure again.
7. **Reverse proxy:** pass every request to `127.0.0.1:<port>` and nothing else. Never serve the
   uploads directory (or any part of the data directory) from the proxy, with `root`, `alias` or a
   static mount: it holds the originals of optimized images at their public keys (see above). With
   nginx, a single `location / { proxy_pass http://127.0.0.1:4321; }` with the usual `Host` and
   forwarding headers; no `location` that points at the file system. A proxy cache must honour
   `Cache-Control: max-age=0, must-revalidate`, or be purged after apply and restore. Not exercised
   in the run.
8. **One process per site.** The safe-media locks are held in the process, so two processes on the
   same data can interleave replacements and restores. Do not run the site under a cluster or process
   manager that forks several workers, do not start a second service (or a copy under another name)
   on the same data directory, and run anything else that opens the data, such as the recovery entry
   point below, only while the service is stopped. systemd refuses a second unit of the same name,
   but nothing stops a second unit under another name; that is the operator's responsibility.

#### Backup

The database, the uploads directory and the private directory are one unit: the database names
revisions and originals by storage key and digest, and the files are only meaningful with it. Back
them up together and restore them together. On this profile, that is the whole data directory:

```sh
systemctl stop site-example
tar --numeric-owner -cpf /backup/site-example-data.tar -C /srv/site-example data
systemctl start site-example
```

and to restore, with the service stopped, replace `/srv/site-example/data` with the archive's
`data` (`tar --numeric-owner -xpf ...`), keep it owned by the site user with the modes above, and
start the service. Keep the archive as private as the data directory: it contains the originals.
A database newer than its private directory refers to originals that are not there (restore then
fails with a missing original); an older one loses the record of replacements. If the service cannot
be stopped, copy SQLite with `sqlite3 .backup` and the files with no apply, restore or run in
progress; backing up with work in progress has not been exercised. The staging directory holds only
output waiting for the host; with nothing in progress it is empty (the run checks this after its bulk
runs). The backup and restore commands above were not part of the run.

#### Rollback

1. **Stop changes:** disable the plugin in the admin. Runs stop between images, scheduled tasks are
   disabled, and every image keeps serving its active file.
2. **Remove the plugin:** take it out of `plugins` in the site configuration, rebuild and restart the
   service. Images keep serving the files they had; the plugin's records stay in the database and are
   found again if it is registered later.
3. **Put originals back without the plugin:** stop the service and restore each optimized image with
   the host's recovery entry point (`emdash/media/safe-recovery`, see the host patches' README), run
   from the site directory **as the site user**, so that the files it writes belong to it. A script
   such as `recover.mjs`:

   ```js
   import { openSafeMediaRecovery } from 'emdash/media/safe-recovery';

   const recovery = await openSafeMediaRecovery({ databasePath, uploadsDirectory, privateDirectory });
   console.log(await recovery.listRestorableOriginals(mediaId));
   console.log(await recovery.restoreMedia(mediaId));
   await recovery.close();
   ```

   run with the service's user and sandbox:

   ```sh
   systemctl stop site-example
   systemd-run --wait --pipe --collect --uid site-example --gid site-example \
     -p UMask=0077 -p ProtectSystem=strict -p ReadWritePaths=/srv/site-example/data \
     --working-directory=/srv/site-example/app /opt/node-v22.16.0/bin/node recover.mjs
   systemctl start site-example
   ```

   Run as root instead, it would leave files the site user cannot read. The run did this for one
   image, in a unit with the site's caps and sandbox; a site needs it for every image the plugin
   optimized.

Going back to an EmDash without the host patches, or without `safeMedia`, has not been exercised. Do
not do it while any image has a replaced revision: restore every image first, since the stock file
route serves whatever file is at the storage key.

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

### Processor limits

The local processor's limits (`src/processor/limits.ts`) and the tick bounds were set from
`calibration/measure-processor.ts` on one VPS: 4 vCPU AMD EPYC 9J45, Debian 13 host, with the work
run in a container capped at 2 CPUs and 3 GiB (memory and swap), Node 22.16, Sharp 0.35.4, one libvips
thread per worker. Each image ran alone in a fresh worker. The figures are the worker's peak resident
memory, read from the kernel, and the encode time, for the largest content measured at each size:
Gaussian noise (the slowest to encode and the largest) and generated photograph-like images
(gradients, texture and grain; not real photographs). Output formats and presets are the ones the
scan offers.

| Input (24 MP, noise) | Encode, balanced / high fidelity | Peak memory | Per megapixel |
| --- | --- | --- | --- |
| PNG | 2.1 s | 340 MiB | 14 MiB |
| JPEG | 4.8 s / 9.3 s | 320 / 550 MiB | 13-23 MiB |
| Lossy WebP | 4.2 s / 12.3 s | 620 / 810 MiB | 26-34 MiB |
| Lossless WebP | 4.1 s | 1310 MiB | 55 MiB |

Across sizes, memory grew about linearly with pixels (lossless WebP: 400 MiB at 6 MP, 690 MiB at
12 MP, 1310 MiB at 24 MP, 1870 MiB at 40 MP; high-fidelity lossy WebP: 280, 440, 810 and 1030 MiB) and
time did too (high-fidelity lossy WebP: 1.6, 3.2, 12.3 and 20.9 s). Photograph-like content used 58% to
96% of the noise memory (lossless WebP 1260 MiB at 24 MP). It encoded JPEG and lossy WebP in 20% to 40%
of the noise time, but PNG (5.5 s at 24 MP, 9.2 s at 40 MP) and lossless WebP (5.3 s, 9.2 s) slower,
because noise is their cheap case. The slowest 24 MP encode of all was high-fidelity lossy WebP of
noise, 12.3 s alone and 12.8 s beside a second worker.

Two workers at once at 24 MP, with no admission limit, to see whether the cap holds:

| Two concurrent encodes, 24 MP | Peak container memory | Result |
| --- | --- | --- |
| PNG, JPEG, lossy WebP (noise) | 750 to 1960 MiB | completed |
| PNG, JPEG, lossy WebP (photograph-like) | 540 to 1410 MiB | completed |
| Lossless WebP (noise) | 3070 of 3072 MiB | out of memory: the kernel killed workers |
| Lossless WebP (photograph-like) | 2930 to 3040 of 3072 MiB | completed, at the cap |

At 40 MP two lossy WebP encodes (high fidelity, noise) reached 2790 MiB, and two lossless WebP
encodes did not fit. So the defaults are:

| Limit | Value | Because |
| --- | --- | --- |
| Pixels per image | 24 MP | one lossy encode of it peaks at 810 MiB |
| Pixels per lossless WebP image | 12 MP | about 58 MiB per megapixel: 700 MiB at 12 MP, 1300 MiB at 24 MP |
| Decoded pixels in flight | 24 million, a lossless WebP pixel counting twice | every admitted mix stays under about 900 MiB of worker memory; with two 12 MP encodes the whole container peaked at 1.5 GiB, including the measuring script, leaving at least 1.5 GiB of the 3 GiB for the site |
| Workers at once | 2 | two CPUs; memory is bounded by the pixel budget, not the count |
| Time per encode | 40 s | three times the slowest 24 MP encode, for a site sharing the two CPUs |
| Input size | 16 MiB | the host's read limit; also bounds the copies the parent holds |
| Per tick | 20 images, none started after 15 s | with the 40 s kill, a tick ends within 55 s of a 60 s interval |

With these defaults in place, two 23.9 MP photograph-like encodes started at once ran one and refused
the other as busy, with no memory kill, and two 12 MP encodes both ran. The input limit decides most
of the rest: noise at 24 MP, a PNG of a photograph-like image above about 5 MP and a lossless WebP above
about 10 MP are larger than 16 MiB and are skipped before any worker starts. The "24 MP" images above are 5657 × 4243
(24.002 million pixels), just over the pixel limit; a 6000 × 4000 image is within it.

Work that does not fit the budget is refused as busy and tried again in a later tick; images over a
limit are skipped. These limits keep encodes within the cap on this hardware with the site using the
rest of the memory, not on any other: the site's own memory use, other Sharp versions and slower or
busier CPUs change the figures, so repeat the measurement (`node --experimental-strip-types
calibration/measure-processor.ts`, run inside the deployment's cap; `--concurrent=2` repeats the
two-worker test) before relying on them elsewhere. A worker's own report of its peak memory also
counts the parent's memory at the moment it was started, so the script reads the kernel's figure for
the worker instead.

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
- Tested in the EmDash plugin test hosts, and the native edition on disposable Node sites of the
  patched host (no real users or content), not on Cloudflare; the report has not been tried with
  users. The 50 ms CPU limit per invocation on Cloudflare has not been measured.
- Apply and restore are a pilot on one host profile: the patched EmDash host at one pinned commit, on
  Node with SQLite and local storage, one process per site, media served only through the site. It
  was exercised on one VPS with generated images. Not exercised: object storage, D1, Cloudflare,
  several processes or hosts for one site, a CDN or caching proxy, real photographs at scale, a site
  with real users, returning to an EmDash without the host patches, and backup and restore with work
  in progress.

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
