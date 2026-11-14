import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

test('现有本机领取作业逐页收取真实资料', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/jobs', { jobId: 'local', source: context.source, actor: 'node-a' })).status, 202);
    for (let count = 0; count < 3; count++) assert.equal((await context.call('/jobs/local/advance', {})).status, 200);
    const result = (await context.call('/jobs/local')).value;
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.received, ['r1', 'r2', 'r3']);
    assert.equal((await context.call('/collections/local')).value.records.length, 3);
  } finally { await context.close(); }
});

test('来源接管代次会拒绝旧领取者', async () => {
  const context = await harness();
  try {
    await context.call('/jobs', { jobId: 'owned', source: context.source, actor: 'node-a' });
    const response = await fetch(context.source + '/ownership', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'owned', actor: 'node-b', expectedGeneration: 1, transferId: 'local-test' }) });
    assert.equal(response.status, 200);
    const old = await context.call('/jobs/owned/advance', {});
    assert.equal(old.status, 502);
    assert.equal((await context.call('/collections/owned')).value.records.length, 0);
  } finally { await context.close(); }
});
