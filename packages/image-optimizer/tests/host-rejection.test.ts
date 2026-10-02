/**
 * Runs in its own Vitest project (see vitest.config.ts), never beside other runtime tests.
 *
 * When the host rejects a storage query, workerd reports the error thrown by the bridge as an
 * uncaught exception and then cancels a request as "hung", even though the plugin catches the
 * error. The cancellation lands on whatever D1 call is in flight in the same workerd, which made
 * unrelated runtime tests fail with "Unexpected end of JSON input". Keeping this file alone in its
 * own workerd contains that; the noise on the console is expected.
 */
import { describe, expect, it } from 'vitest';

import { createPluginRuntimeTestHost } from '@emdash-cms/plugin-test';

import { scanFromReport } from './runtime-helpers.ts';

describe('host rejection', () => {
  it('falls back to the first page for a cursor the host rejects', async () => {
    const host = await createPluginRuntimeTestHost();
    try {
      await host.fixtures.media({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([0]),
        reportedSize: 600_000,
        width: 1200,
        height: 800,
      });
      await scanFromReport(host);

      const page = await host.admin.act('/report', 'results_page', { value: { cursor: 'not-a-cursor' } });
      const table = page.blocks.find((block) => block.type === 'table' && block.block_id === 'results');
      expect(table).toMatchObject({ rows: [expect.objectContaining({ file: 'photo.jpg' })] });
      expect(page.blocks.find((block) => block.type === 'section')).toMatchObject({
        text: 'Images that could be smaller, largest estimated saving first.',
      });
    } finally {
      await host.dispose();
    }
  });
});
