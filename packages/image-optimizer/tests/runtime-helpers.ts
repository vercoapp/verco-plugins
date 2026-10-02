import type { PluginRuntimeTestHost } from '@emdash-cms/plugin-test';

import type { ScanRun } from '../src/job.ts';

/** Runs the scheduled scan task once, as the host's cron would. */
export async function tick(host: PluginRuntimeTestHost): Promise<ScanRun | null> {
  await host.transport.invokeHook('cron', { name: 'scan-step', scheduledAt: new Date().toISOString() });
  return host.inspect.kv.get<ScanRun>('state:scan');
}

/** Runs the scheduled task until the scan completes. */
export async function finishScan(host: PluginRuntimeTestHost): Promise<ScanRun> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await tick(host);
    if (run?.phase === 'complete') return run;
  }
  throw new Error('The scan did not complete in 20 ticks');
}

/** Starts a scan from the report page, finishes it, and reloads the page. */
export async function scanFromReport(host: PluginRuntimeTestHost, options: { locale?: string } = {}) {
  const started = await host.admin.act('/report', 'start_scan', options);
  await finishScan(host);
  const page = await host.admin.loadPage('/report', options);
  return { started, page };
}
