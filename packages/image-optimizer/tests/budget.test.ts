/**
 * Cloudflare counts every bridge call toward the sandbox's subrequest limit, and neither the Node
 * runner nor the test hosts enforce it. These tests drive the plugin's real hooks and routes against
 * a fake host that counts calls, in the worst cases each entry point can meet.
 */
import { describe, expect, it } from 'vitest';

import { BRIDGE_CALL_LIMIT, startScan, type StoredResult } from '../src/job.ts';
import plugin from '../src/plugin.ts';
import { DEFAULT_SCAN_OPTIONS } from '../src/scanner.ts';
import { fakeHost, jpegs } from './fake-host.ts';

type Host = ReturnType<typeof fakeHost>;
type Handler = (...args: unknown[]) => Promise<unknown>;

function hook(name: 'cron' | 'media:afterUpload'): Handler {
  const entry = plugin.hooks![name] as unknown;
  return (typeof entry === 'function' ? entry : (entry as { handler: Handler }).handler) as Handler;
}

function route(name: string): Handler {
  return (plugin.routes![name] as unknown as { handler: Handler }).handler;
}

const cron = (host: Host) => hook('cron')({ name: 'scan-step', scheduledAt: '' }, host.ctx);
const admin = (host: Host, input: unknown) => route('admin')({ input, request: {}, ui: { locale: 'en' } }, host.ctx);

/** Results left by an earlier run, which a finished sweep deletes. */
function staleResults(host: Host, count: number) {
  for (let index = 0; index < count; index += 1) {
    host.results.set(`old${index}`, { runId: '2000-01-01T00:00:00.000Z', status: 'ok' } as StoredResult);
  }
}

async function expectWithinLimit(host: Host, action: () => Promise<unknown>): Promise<number> {
  const calls = await host.callsDuring(action);
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThanOrEqual(BRIDGE_CALL_LIMIT);
  return calls;
}

describe('bridge calls per invocation', () => {
  it('keeps a scan tick within the limit in the middle of a sweep', async () => {
    const host = fakeHost(jpegs(1000));
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await expectWithinLimit(host, () => cron(host));
    expect(host.state()).toMatchObject({ phase: 'sweep', totals: { scanned: 300 } });
  });

  it('keeps the tick that ends the sweep within the limit while it cleans up', async () => {
    const host = fakeHost(jpegs(250));
    staleResults(host, 1000);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await expectWithinLimit(host, () => cron(host));
    expect(host.state()?.phase).toBe('cleanup');

    // Cleanup ticks until every stale result is gone, then the task is cancelled.
    host.tasks.set('scan-step', { schedule: '* * * * *' });
    for (let tickCount = 0; host.state()?.phase !== 'complete'; tickCount += 1) {
      expect(tickCount).toBeLessThan(20);
      await expectWithinLimit(host, () => cron(host));
    }
    expect([...host.results.keys()].filter((id) => id.startsWith('old'))).toEqual([]);
    expect(host.tasks.size).toBe(0);
  });

  it('keeps a tick with no scan within the limit and cancels the task', async () => {
    const host = fakeHost([]);
    host.tasks.set('scan-step', { schedule: '* * * * *' });
    expect(await expectWithinLimit(host, () => cron(host))).toBe(2);
    expect(host.tasks.size).toBe(0);
  });

  it('keeps starting a scan from the report within the limit', async () => {
    const host = fakeHost(jpegs(10));
    host.settings.set('maxDimension', 2000);
    await expectWithinLimit(host, () => admin(host, { type: 'block_action', action_id: 'start_scan' }));
    expect(host.tasks.has('scan-step')).toBe(true);

    // Again while it runs, and with settings the scan cannot use.
    await expectWithinLimit(host, () => admin(host, { type: 'block_action', action_id: 'start_scan' }));
    const invalid = fakeHost([]);
    invalid.settings.set('minSavingsPercent', 150);
    await expectWithinLimit(invalid, () => admin(invalid, { type: 'block_action', action_id: 'start_scan' }));
  });

  it('keeps the report, its pages and the widget within the limit', async () => {
    const host = fakeHost(jpegs(120));
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    await cron(host);

    const page = (await admin(host, { type: 'page_load', page: '/report' })) as {
      blocks: Array<{ type: string; block_id?: string; next_cursor?: string }>;
    };
    await expectWithinLimit(host, () => admin(host, { type: 'page_load', page: '/report' }));
    const cursor = page.blocks.find((block) => block.block_id === 'results')?.next_cursor;
    expect(cursor).toBeDefined();
    await expectWithinLimit(host, () =>
      admin(host, { type: 'block_action', action_id: 'results_page', value: { cursor } }),
    );
    // A rejected cursor costs a second query for the first page.
    await expectWithinLimit(host, () =>
      admin(host, { type: 'block_action', action_id: 'results_page', value: { cursor: 'not-a-cursor' } }),
    );
    expect(await expectWithinLimit(host, () => admin(host, { type: 'page_load', page: 'widget:savings' }))).toBe(1);
  });

  it('keeps the upload hook within the limit when both attempts conflict', async () => {
    const library = jpegs(5);
    const host = fakeHost(library);
    await startScan(host.deps, DEFAULT_SCAN_OPTIONS);
    library.unshift(...jpegs(1, {}, 'new'));

    const conflict = async () => {
      host.touchState();
      host.onNextCompareAndSet(async () => host.touchState());
    };
    host.onNextCompareAndSet(conflict);
    await expectWithinLimit(host, () => hook('media:afterUpload')({ media: { id: 'new0000' } }, host.ctx));
    expect(host.logs).toEqual([{ level: 'warn', message: expect.stringContaining('repeated conflicts') }]);
  });

  it('keeps the start and status routes within the limit', async () => {
    const host = fakeHost(jpegs(10));
    await expectWithinLimit(host, () => route('scan-start')({ input: undefined, request: {} }, host.ctx));
    expect(await expectWithinLimit(host, () => route('scan-status')({ input: undefined, request: {} }, host.ctx))).toBe(1);
  });
});
