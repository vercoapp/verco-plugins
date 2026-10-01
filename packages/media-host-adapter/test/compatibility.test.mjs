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
