import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { harness } from './harness.mjs';

const context = await harness();
const directory = await mkdtemp(join(tmpdir(), 'moved-job-'));
const destination = await createService({ directory, allowedOrigin: context.source });
await new Promise(resolve => destination.server.listen(0, '127.0.0.1', resolve));
const rivalDirectory = await mkdtemp(join(tmpdir(), 'rival-job-'));
const rival = await createService({ directory: rivalDirectory, allowedOrigin: context.source });
await new Promise(resolve => rival.server.listen(0, '127.0.0.1', resolve));
const other = `http://127.0.0.1:${destination.server.address().port}`;
async function call(path, body) {
  const response = await fetch(other + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: response.status, value: await response.json() };
}
try {
  assert.equal((await context.call('/jobs', { jobId: 'move', source: context.source, actor: 'node-a' })).status, 202);
  assert.equal((await context.call('/jobs/move/advance', {})).value.received.length, 1);
  const exported = await context.call('/jobs/move/export', {});
  assert.equal(exported.status, 200, '未找到所需资料观察: 可移交进度包');
  assert.ok(exported.value.bundle);
  const serialized = JSON.stringify(exported.value.bundle);
  assert.ok(!serialized.includes('session-node-a') && !serialized.includes('/cursor/'), '移交包泄露会话凭据或临时游标');
  assert.equal((await call('/jobs/import', { bundle: exported.value.bundle, source: context.source, actor: 'node-b' })).status, 201);
  assert.equal((await context.call('/jobs/move/advance', {})).status, 409, '移交后旧领取者仍能推进');
  for (let count = 0; count < 6; count++) {
    const result = await call('/jobs/move/advance', {});
    assert.equal(result.status, 200);
    if (result.value.state === 'completed') break;
  }
  const result = (await call('/collections/move')).value;
  const ids = result.records.filter(record => record.kind === 'collected-item').map(record => record.value.id).sort();
  assert.deepEqual(ids, ['r1', 'r2', 'r3']);
  for (const record of result.records) for (const origin of record.provenance) assert.equal((await call('/receipts/' + origin.receiptId)).status, 200);
  const repeated = await fetch(`http://127.0.0.1:${rival.server.address().port}/jobs/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle: exported.value.bundle, source: context.source, actor: 'node-c' }) });
  assert.equal(repeated.status, 409, '相同进度包被另一独立目录的接管者重复消费');
  console.log(JSON.stringify({ moved: 'move', sourceItems: ids, originalReceiver: 'fenced', temporaryCursorExported: false }));
} finally {
  rival.server.closeAllConnections();
  await new Promise(resolve => rival.server.close(resolve));
  destination.server.closeAllConnections();
  await new Promise(resolve => destination.server.close(resolve));
  await context.close(); await rm(directory, { recursive: true, force: true }); await rm(rivalDirectory, { recursive: true, force: true });
}
