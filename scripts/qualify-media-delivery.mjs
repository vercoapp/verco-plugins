import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build, dev, preview } from 'astro';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = JSON.parse(await readFile(join(root, 'host/emdash/target.json'), 'utf8'));
const checkout = join(root, target.checkout);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), target.commit);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim(), '');

const runRoot = join(root, '.qualification-runs');
await mkdir(runRoot, { recursive: true });
const site = await mkdtemp(join(runRoot, 'delivery-'));
const data = join(site, 'data');
await cp(join(root, 'fixtures/safe-media-delivery'), site, { recursive: true });
await mkdir(join(data, 'active/objects'), { recursive: true });
await mkdir(join(data, 'originals'), { recursive: true });
const db = new DatabaseSync(join(data, 'media.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE revisions (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE media (id TEXT PRIMARY KEY, stable_key TEXT UNIQUE NOT NULL, active_revision TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const images = {};
for (const [name, color] of [['original', '#e02020'], ['candidate', '#2060e0']]) {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer();
  const objectKey = `objects/${digest(bytes)}.png`;
  await writeFile(join(data, 'active', objectKey), bytes);
  db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?)').run(name, objectKey, digest(bytes), bytes.length);
  images[name] = { bytes, objectKey };
}
db.prepare('INSERT INTO media VALUES (?, ?, ?, 0)').run('fixture', 'fixture.png', 'original');
await writeFile(join(data, 'originals/source.png'), images.original.bytes);

const priorEnvironment = Object.fromEntries(['VERCO_MEDIA_FIXTURE_DIR', 'VERCO_MEDIA_FIXTURE_ORIGIN'].map((name) => [name, process.env[name]]));
process.env.VERCO_MEDIA_FIXTURE_DIR = data;
let devServer;
let production;
const timings = [];
const baseline = { root: site, cacheDir: join(site, 'image-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } };

async function assertPixels(bytes, expected) {
  const { data: pixels, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 8);
  const wanted = expected === 'original' ? [224, 32, 32] : [32, 96, 224];
  assert.deepEqual([...pixels.subarray(0, 3)], wanted);
}

async function getImage(origin, path, expected, transformed = false, runtime = 'production') {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!transformed) assert.equal(digest(bytes), digest(images[expected].bytes));
  else await assertPixels(bytes, expected);
  timings.push({ runtime, path, revision: expected, elapsedMs: Number((performance.now() - started).toFixed(2)) });
}

async function assertHidden(origin) {
  for (const key of [images.original.objectKey, 'originals/source.png', 'backups/source.png', 'transfers/source.png', 'source.png', '%2562ackups/source.png']) {
    const response = await fetch(`${origin}/_emdash/api/media/file/${key}`);
    assert.equal(response.status, 404, `Private/object key exposed: ${key}`);
  }
  const href = '/_emdash/api/media/file/source.png';
  assert.equal((await fetch(`${origin}/_image?href=${encodeURIComponent(href)}&w=8&f=png`)).status, 404);
}

async function staticImage(origin, path = '/static/') {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const src = /<img\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  assert.ok(src, 'Prerendered Image must produce an img src');
  assert.ok(src.startsWith('/_astro/'), `Expected generated static asset, received ${src}`);
  const image = await fetch(`${origin}${src}`);
  assert.equal(image.status, 200);
  return { src, cacheControl: image.headers.get('cache-control'), bytes: Buffer.from(await image.arrayBuffer()) };
}

try {
  devServer = await dev(baseline);
  const address = devServer.address;
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.VERCO_MEDIA_FIXTURE_ORIGIN = origin;
  const direct = '/_emdash/api/media/file/fixture.png';
  const transformed = `/_image?href=${encodeURIComponent(direct)}&w=8&h=8&f=png`;
  await getImage(origin, direct, 'original', false, 'development');
  await getImage(origin, transformed, 'original', true, 'development');
  await assertHidden(origin);

  const firstBuild = join(site, "dist-original");
  await build({ ...baseline, outDir: firstBuild });
  production = await preview({ ...baseline, outDir: firstBuild });
  const productionOrigin = `http://127.0.0.1:${production.server.address().port}`;
  const originalStatic = await staticImage(productionOrigin);
  const originalVersioned = await staticImage(productionOrigin, '/versioned-static/');
  await assertPixels(originalStatic.bytes, 'original');
  await assertPixels(originalVersioned.bytes, 'original');
  assert.equal(originalStatic.cacheControl, 'public, max-age=31536000, immutable');
  await getImage(productionOrigin, direct, 'original');
  await getImage(productionOrigin, transformed, 'original', true);

  db.prepare("UPDATE media SET active_revision = 'candidate' WHERE id = 'fixture' AND active_revision = 'original'").run();
  await getImage(productionOrigin, direct, 'candidate');
  await getImage(productionOrigin, transformed, 'candidate', true);
  const staleStatic = await staticImage(productionOrigin);
  assert.equal(digest(staleStatic.bytes), digest(originalStatic.bytes), 'Static output should remain unchanged before rebuild');
  assert.equal(digest((await staticImage(productionOrigin, '/versioned-static/')).bytes), digest(originalVersioned.bytes));
  // A build token must never silently serve a different current revision.
  assert.equal((await fetch(`${productionOrigin}${direct}?rev=${digest(images.original.bytes)}`)).status, 404);
  await assertHidden(productionOrigin);
  await production.stop();
  production = undefined;

  const secondBuild = join(site, "dist-candidate");
  await build({ ...baseline, outDir: secondBuild });
  production = await preview({ ...baseline, outDir: secondBuild });
  const rebuiltOrigin = `http://127.0.0.1:${production.server.address().port}`;
  const rebuiltStatic = await staticImage(rebuiltOrigin);
  const rebuiltVersioned = await staticImage(rebuiltOrigin, '/versioned-static/');
  await assertPixels(rebuiltStatic.bytes, 'candidate');
  await assertPixels(rebuiltVersioned.bytes, 'candidate');
  assert.equal(rebuiltStatic.src, originalStatic.src, 'Unversioned remote input reuses the immutable output URL');
  assert.notEqual(rebuiltVersioned.src, originalVersioned.src, 'Revision-aware input must produce a new output URL');

  db.prepare("UPDATE media SET active_revision = 'original' WHERE id = 'fixture' AND active_revision = 'candidate'").run();
  await getImage(rebuiltOrigin, direct, 'original');
  await getImage(rebuiltOrigin, transformed, 'original', true);
  assert.equal(digest((await staticImage(rebuiltOrigin)).bytes), digest(rebuiltStatic.bytes), 'Restore also requires rebuilding static assets');
  await production.stop();
  production = undefined;
  const restoredBuild = join(site, 'dist-restored');
  await build({ ...baseline, outDir: restoredBuild });
  production = await preview({ ...baseline, outDir: restoredBuild });
  const restoredOrigin = `http://127.0.0.1:${production.server.address().port}`;
  const restoredVersioned = await staticImage(restoredOrigin, '/versioned-static/');
  await assertPixels(restoredVersioned.bytes, 'original');
  assert.equal(restoredVersioned.src, originalVersioned.src, 'Byte-exact restore can reuse the original digest asset');
  db.prepare("UPDATE media SET deleted = 1 WHERE id = 'fixture'").run();
  for (const path of [direct, transformed]) assert.equal((await fetch(`${restoredOrigin}${path}`)).status, 404);

  const evidence = {
    timestamp: new Date().toISOString(),
    targetCommit: target.commit,
    node: process.version,
    tooling: Object.fromEntries(await Promise.all(['astro', '@astrojs/node', 'sharp', 'mime', 'zod'].map(async (name) => {
      const metadata = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      return [name, metadata.version];
    }))),
    profile: 'node-sqlite-local-host-resolver-prototype',
    fixtureOnly: true,
    directAndTransformSwitch: 'next request resolves the selected complete revision',
    staticRebuild: 'required after replacement and restore; render remote source with the current revision digest',
    unversionedStatic: 'rebuild refreshes bytes but reuses a year-long immutable URL; unsupported without cache invalidation',
    revisionAwareStatic: 'warm-cache rebuild creates a new asset URL after replacement and restores original pixels after restore',
    privateAndObjectUrls: '404',
    deletion: 'direct and transformed URLs return 404',
    measurements: timings,
    generatedStaticSources: {
      unversionedOriginal: originalStatic.src, unversionedRebuilt: rebuiltStatic.src,
      versionedOriginal: originalVersioned.src, versionedRebuilt: rebuiltVersioned.src,
      versionedRestored: restoredVersioned.src,
    },
    sharp: sharp.versions,
  };
  const evidenceFile = join(root, 'host/emdash/qualification/delivery-latest.json');
  await mkdir(join(root, 'host/emdash/qualification'), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Delivery qualification prototype passed. Evidence: ${evidenceFile}`);
} finally {
  if (production) await production.stop();
  if (devServer) await devServer.stop();
  db.close();
  for (const [name, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(site, { recursive: true, force: true });
}
