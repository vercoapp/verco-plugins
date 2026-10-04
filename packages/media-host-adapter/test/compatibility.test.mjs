import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMediaHostAdapter,
  UnsupportedMediaHostError,
} from '../src/index.ts';

test('missing host support leaves scanning available and rejects both mutations', async () => {
  const adapter = createMediaHostAdapter();
  const status = await adapter.availability();
  assert.equal(status.scan, true);
  assert.equal(status.apply, false);
  assert.equal(status.restore, false);
  assert.equal(status.reason, 'missing-host-operation');
  await assert.rejects(adapter.apply(), UnsupportedMediaHostError);
  await assert.rejects(adapter.restore(), UnsupportedMediaHostError);
});

test('discovery failure gives a safe compatibility reason without leaking details', async () => {
  const adapter = createMediaHostAdapter({
    discover: async () => { throw new Error('secret transport detail'); },
  });
  const status = await adapter.availability();
  assert.equal(status.scan, true);
  assert.equal(status.reason, 'host-discovery-failed');
  assert.doesNotMatch(status.message, /secret transport detail/);
  await assert.rejects(adapter.apply(), UnsupportedMediaHostError);
});

test('host claims and malformed discovery cannot enable unqualified mutation', async () => {
  for (const claim of [
    { version: 1, supported: true, profile: 'node-sqlite-local' },
    { version: 999, supported: true },
    {}, 'supported', true, false,
  ]) {
    let writes = 0;
    const adapter = createMediaHostAdapter({
      discover: async () => claim,
      apply: async () => { writes++; },
      restore: async () => { writes++; },
    });
    const status = await adapter.availability();
    assert.equal(status.reason, 'unqualified-host');
    await assert.rejects(adapter.apply(), UnsupportedMediaHostError);
    await assert.rejects(adapter.restore(), UnsupportedMediaHostError);
    assert.equal(writes, 0);
  }
});

test('mutation guard works without calling discovery first', async () => {
  let calls = 0;
  const adapter = createMediaHostAdapter({
    discover: async () => { calls++; return { supported: true }; },
  });
  await assert.rejects(adapter.apply(), UnsupportedMediaHostError);
  await assert.rejects(adapter.restore(), UnsupportedMediaHostError);
  assert.equal(calls, 0);
});

const LOCAL = Object.freeze({ runtime: 'node', database: 'sqlite', storage: 'local', locks: 'in-process' });
const support = (overrides = {}) => ({ protocol: 1, profile: LOCAL, ...overrides });

function recordingHost(discovered) {
  const calls = { discover: 0, apply: [], restore: [] };
  return {
    calls,
    host: {
      discover: async () => { calls.discover++; return discovered; },
      apply: async (request) => { calls.apply.push(request); return { ok: true, receipt: 'applied' }; },
      restore: async (request) => { calls.restore.push(request); return { ok: true, receipt: 'restored' }; },
    },
  };
}

test('nothing is qualified by default, so a real host description stays read-only', async () => {
  const { host, calls } = recordingHost(support());
  const adapter = createMediaHostAdapter(host);
  const status = await adapter.availability();
  assert.equal(status.apply, false);
  assert.equal(status.reason, 'unqualified-host');
  await assert.rejects(adapter.apply({}), UnsupportedMediaHostError);
  await assert.rejects(adapter.restore({}), UnsupportedMediaHostError);
  assert.deepEqual([calls.apply.length, calls.restore.length], [0, 0]);
});

test('a known protocol on an injected qualified profile enables apply and restore', async () => {
  const { host, calls } = recordingHost(support());
  const adapter = createMediaHostAdapter(host, { qualifiedProfiles: [{ ...LOCAL }] });
  const status = await adapter.availability();
  assert.equal(status.apply, true);
  assert.equal(status.restore, true);
  assert.equal(status.reason, 'qualified-host');
  assert.deepEqual(status.profile, LOCAL);
  assert.deepEqual(await adapter.apply({ id: 'a' }), { ok: true, receipt: 'applied' });
  assert.deepEqual(await adapter.restore({ id: 'r' }), { ok: true, receipt: 'restored' });
  assert.deepEqual(calls.apply, [{ id: 'a' }]);
  assert.deepEqual(calls.restore, [{ id: 'r' }]);
});

test('an unknown protocol stays read-only with its own reason', async () => {
  for (const protocol of [0, 2, 999]) {
    const { host, calls } = recordingHost(support({ protocol }));
    const adapter = createMediaHostAdapter(host, { qualifiedProfiles: [LOCAL] });
    const status = await adapter.availability();
    assert.equal(status.apply, false);
    assert.equal(status.reason, 'unknown-protocol');
    await assert.rejects(adapter.apply({}), (error) => error.reason === 'unknown-protocol');
    await assert.rejects(adapter.restore({}), (error) => error.reason === 'unknown-protocol');
    assert.deepEqual([calls.apply.length, calls.restore.length], [0, 0]);
  }
});

test('unqualified profiles, including object storage and D1, stay read-only and are named', async () => {
  for (const [profile, named] of [
    [{ ...LOCAL, storage: 'r2' }, /storage r2/],
    [{ ...LOCAL, storage: 's3' }, /storage s3/],
    [{ ...LOCAL, database: 'd1' }, /database d1/],
    [{ ...LOCAL, runtime: 'workerd' }, /runtime workerd/],
    [{ ...LOCAL, locks: 'distributed' }, /locks distributed/],
    [{ ...LOCAL, replicas: 'many' }, /replicas many/],
    [{ runtime: 'node', database: 'sqlite', storage: 'local' }, /storage local/],
  ]) {
    const { host, calls } = recordingHost(support({ profile }));
    const adapter = createMediaHostAdapter(host, { qualifiedProfiles: [LOCAL] });
    const status = await adapter.availability();
    assert.equal(status.apply, false, JSON.stringify(profile));
    assert.equal(status.reason, 'unqualified-host');
    assert.match(status.message, named);
    await assert.rejects(adapter.apply({}), (error) => error.reason === 'unqualified-host');
    await assert.rejects(adapter.restore({}), (error) => error.reason === 'unqualified-host');
    assert.deepEqual([calls.apply.length, calls.restore.length], [0, 0]);
  }
});

test('discovery failure and absent access stay read-only with distinct reasons even when a profile is qualified', async () => {
  let writes = 0;
  const operations = { apply: async () => { writes++; }, restore: async () => { writes++; } };
  const failing = createMediaHostAdapter(
    { ...operations, discover: async () => { throw new Error('secret transport detail'); } },
    { qualifiedProfiles: [LOCAL] },
  );
  const failed = await failing.availability();
  assert.equal(failed.reason, 'host-discovery-failed');
  assert.doesNotMatch(failed.message, /secret transport detail/);
  await assert.rejects(failing.apply({}), (error) => error.reason === 'host-discovery-failed');

  for (const absent of [null, undefined]) {
    const adapter = createMediaHostAdapter({ ...operations, discover: async () => absent }, { qualifiedProfiles: [LOCAL] });
    assert.equal((await adapter.availability()).reason, 'missing-host-operation');
    await assert.rejects(adapter.restore({}), (error) => error.reason === 'missing-host-operation');
  }
  const noDiscovery = createMediaHostAdapter(operations, { qualifiedProfiles: [LOCAL] });
  assert.equal((await noDiscovery.availability()).reason, 'missing-host-operation');
  await assert.rejects(noDiscovery.apply({}), UnsupportedMediaHostError);
  assert.equal(writes, 0);
});

test('mutation re-checks discovery at the time of the call', async () => {
  let discovered = support();
  let writes = 0;
  const adapter = createMediaHostAdapter(
    { discover: async () => discovered, apply: async () => { writes++; }, restore: async () => { writes++; } },
    { qualifiedProfiles: [LOCAL] },
  );
  assert.equal((await adapter.availability()).apply, true);
  discovered = support({ profile: { ...LOCAL, storage: 'r2' } });
  await assert.rejects(adapter.apply({}), UnsupportedMediaHostError);
  assert.equal(writes, 0);
});

test('a qualified host without the operation is refused rather than skipped', async () => {
  const adapter = createMediaHostAdapter({ discover: async () => support() }, { qualifiedProfiles: [LOCAL] });
  await assert.rejects(adapter.apply({}), (error) => error.reason === 'missing-host-operation');
});
