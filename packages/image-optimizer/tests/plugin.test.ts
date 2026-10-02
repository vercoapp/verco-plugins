import { afterEach, describe, expect, it } from 'vitest';

import { createPluginTestHost, type PluginTestHost } from '@emdash-cms/plugin-test';

let host: PluginTestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

describe('plugin', () => {
  it('loads in the sandbox test host with read-only media access and no network', async () => {
    host = await createPluginTestHost();
    expect(host.manifest.capabilities).toEqual(['media:read']);
    expect(host.manifest.allowedHosts).toEqual([]);
  });
});
