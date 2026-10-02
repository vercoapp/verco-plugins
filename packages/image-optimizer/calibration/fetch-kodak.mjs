// Downloads the Kodak Lossless True Color Image Suite (24 PNG photographs, 768 x 512) into the
// ignored `.calibration/kodak` directory. The suite was released by Kodak for unrestricted use and is
// a standard image-compression benchmark. Nothing downloaded here is committed.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const target = new URL('../.calibration/kodak/', import.meta.url).pathname;
const base = 'https://r0k.us/graphics/kodak/kodak/';

await mkdir(target, { recursive: true });
for (let index = 1; index <= 24; index += 1) {
  const name = `kodim${String(index).padStart(2, '0')}.png`;
  const path = join(target, name);
  if (await stat(path).then(() => true, () => false)) continue;
  const response = await fetch(base + name);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  process.stdout.write(`${name}\n`);
}
console.log(`Kodak suite in ${target}`);
