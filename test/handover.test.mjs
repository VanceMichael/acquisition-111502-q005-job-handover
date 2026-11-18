import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { harness } from './harness.mjs';
import { createService } from '../src/service.mjs';
import { sha256Json } from '../src/handover.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function peerService(source) {
  const directory = await mkdtemp(join(tmpdir(), 'handover-peer-'));
  let service = await createService({ directory, allowedOrigin: source });
  let base = await listen(service.server);
  return {
    directory,
    get base() { return base; },
    async call(path, body) {
      const response = await fetch(base + path, body === undefined ? undefined : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: response.status, value: await response.json() };
    },
    async restart() {
      service.server.closeAllConnections();
      await new Promise(resolve => service.server.close(resolve));
      service = await createService({ directory, allowedOrigin: source });
      base = await listen(service.server);
    },
    async close() {
      service.server.closeAllConnections();
      await new Promise(resolve => service.server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function fakeSource(logicalSourceId) {
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/catalog')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ logicalSourceId }));
    }
    response.writeHead(404); response.end();
  });
  return { server };
}

async function exportAfterOnePage(context, jobId = 'move') {
  assert.equal((await context.call('/jobs', { jobId, source: context.source, actor: 'node-a' })).status, 202);
  assert.equal((await context.call(`/jobs/${jobId}/advance`, {})).value.received.length, 1);
  const exported = await context.call(`/jobs/${jobId}/export`, {});
  assert.equal(exported.status, 200);
  return exported.value.bundle;
}

test('移交包携带可回查原文与出处，且不含会话凭据、临时游标或绝对路径', async () => {
  const context = await harness();
  try {
    const bundle = await exportAfterOnePage(context);
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes('session-node-a'));
    assert.ok(!serialized.includes('/cursor/'));
    assert.ok(!serialized.includes(context.directory));
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.source.logicalSourceId, 'partner-catalog-1');
    assert.equal(bundle.job.lastCommitted, 1);
    assert.deepEqual(bundle.job.received, ['r1']);
    assert.equal(bundle.blobs.length, 1);
    assert.equal(bundle.receipts.length, 1);
    assert.equal(bundle.records.length, 1);
    // 清单摘要把原文、收件、记录与水位绑定，transferId 再绑定清单，形成可核对链。
    assert.equal(sha256Json(bundle.manifest), bundle.integrity.manifestDigest);
    assert.ok(bundle.transferId);
  } finally { await context.close(); }
});

test('原文字节缺失或被改动、清单或记录被改动都拒绝接管', async () => {
  const context = await harness();
  const peer = await peerService(context.source);
  try {
    const original = await exportAfterOnePage(context);
    const clone = () => JSON.parse(JSON.stringify(original));

    let tampered = clone();
    tampered.blobs[0].contentBase64 = Buffer.from('被篡改的字节').toString('base64');
    assert.equal((await peer.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    tampered = clone();
    tampered.blobs = [];
    assert.equal((await peer.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    tampered = clone();
    tampered.manifest.lastCommitted = 99;
    assert.equal((await peer.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    tampered = clone();
    tampered.records[0].value.payload.value = 999;
    assert.equal((await peer.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    tampered = clone();
    tampered.receipts[0].sourceKey = tampered.receipts[0].sourceKey + '-moved';
    assert.equal((await peer.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    // 全部篡改尝试均未建立接管资格，原包仍可正常导入。
    assert.equal((await peer.call('/jobs/import', { bundle: original, source: context.source, actor: 'node-b' })).status, 201);
  } finally { await peer.close(); await context.close(); }
});

test('逻辑来源不一致或非授权来源拒绝导入，不凭地址相似放行', async () => {
  const context = await harness();
  const bundle = await exportAfterOnePage(context);
  const other = fakeSource('partner-catalog-2');
  const otherOrigin = await listen(other.server);
  const peer = await peerService(otherOrigin);
  try {
    assert.equal((await peer.call('/jobs/import', { bundle, source: otherOrigin, actor: 'node-b' })).status, 409);
    assert.equal((await peer.call('/jobs/import', { bundle, source: 'http://outside.invalid', actor: 'node-b' })).status, 403);
  } finally { await peer.close(); other.server.closeAllConnections(); await new Promise(resolve => other.server.close(resolve)); await context.close(); }
});

test('旧实例重启后仍被栅栏拒绝，新实例重启后按水位续领且不重复', async () => {
  const context = await harness();
  const peer = await peerService(context.source);
  try {
    const bundle = await exportAfterOnePage(context);
    assert.equal((await peer.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' })).status, 201);

    await context.restart();
    assert.equal((await context.call('/jobs/move/advance', {})).status, 409);
    assert.equal((await context.call('/jobs/move')).value.state, 'exported');

    await peer.restart();
    for (let count = 0; count < 6; count++) {
      const result = await peer.call('/jobs/move/advance', {});
      assert.equal(result.status, 200);
      if (result.value.state === 'completed') break;
    }
    const collection = (await peer.call('/collections/move')).value;
    const ids = collection.records.filter(record => record.kind === 'collected-item').map(record => record.value.id);
    assert.deepEqual([...ids].sort(), ['r1', 'r2', 'r3']);
    assert.equal(new Set(ids).size, ids.length, '重叠补领产生了重复资料');
    const job = (await peer.call('/jobs/move')).value;
    assert.deepEqual(job.received, ['r1', 'r2', 'r3']);
    for (const record of collection.records) {
      for (const origin of record.provenance) assert.equal((await peer.call('/receipts/' + origin.receiptId)).status, 200);
    }
  } finally { await peer.close(); await context.close(); }
});

test('同一进度包只允许一个有效接管者，原接管者重放幂等', async () => {
  const context = await harness();
  const peer = await peerService(context.source);
  const rival = await peerService(context.source);
  try {
    const bundle = await exportAfterOnePage(context);
    const first = await peer.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' });
    assert.equal(first.status, 201);
    assert.equal(first.value.resumeAfter, 1);
    assert.equal(first.value.logicalSourceId, 'partner-catalog-1');
    assert.deepEqual(first.value.restored, { receipts: 1, blobs: 1, records: 1 });

    const replayed = await peer.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' });
    assert.equal(replayed.status, 201);
    assert.equal(replayed.value.duplicate, true);

    assert.equal((await rival.call('/jobs/import', { bundle, source: context.source, actor: 'node-c' })).status, 409);
    assert.equal((await peer.call('/jobs/import', { bundle, source: context.source, actor: 'node-c' })).status, 409);
    // 竞争失败方没有产生任何本资料集写入。
    const rivalCollection = await rival.call('/collections/move');
    assert.deepEqual(rivalCollection.value.records, []);
    assert.deepEqual(rivalCollection.value.receiptIds, []);
  } finally { await rival.close(); await peer.close(); await context.close(); }
});

test('导出与进行中的领取并发时先排空该页，移交不丢页', async () => {
  const context = await harness();
  try {
    assert.equal((await context.call('/jobs', { jobId: 'race', source: context.source, actor: 'node-a' })).status, 202);
    const [advanceResult, exportResult] = await Promise.all([
      context.call('/jobs/race/advance', {}),
      context.call('/jobs/race/export', {}),
    ]);
    assert.equal(advanceResult.status, 200);
    assert.equal(exportResult.status, 200);
    const bundle = exportResult.value.bundle;
    assert.equal(bundle.job.lastCommitted, 1);
    assert.deepEqual(bundle.job.received, ['r1']);
    assert.equal(bundle.records.length, 1);
    assert.equal((await context.call('/jobs/race/advance', {})).status, 409);
  } finally { await context.close(); }
});

test('已完成作业可移交，新实例保持完成态且原文可回查', async () => {
  const context = await harness();
  const peer = await peerService(context.source);
  try {
    assert.equal((await context.call('/jobs', { jobId: 'done', source: context.source, actor: 'node-a' })).status, 202);
    for (let count = 0; count < 3; count++) await context.call('/jobs/done/advance', {});
    const bundle = (await context.call('/jobs/done/export', {})).value.bundle;
    assert.equal(bundle.job.state, 'completed');
    assert.equal(bundle.job.lastCommitted, 3);
    const imported = await peer.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' });
    assert.equal(imported.status, 201);
    assert.equal(imported.value.state, 'completed');
    const state = (await peer.call('/jobs/done')).value;
    assert.equal(state.state, 'completed');
    const again = await peer.call('/jobs/done/advance', {});
    assert.equal(again.status, 200);
    assert.equal(again.value.state, 'completed');
    const collection = (await peer.call('/collections/done')).value;
    assert.equal(collection.records.length, 3);
  } finally { await peer.close(); await context.close(); }
});

test('重复导出产生内容一致的进度包，且导出后人工收件接口不受影响', async () => {
  const context = await harness();
  try {
    const first = await exportAfterOnePage(context, 'stable');
    const second = (await context.call('/jobs/stable/export', {})).value.bundle;
    assert.equal(second.transferId, first.transferId);
    assert.equal(sha256Json(second.manifest), first.integrity.manifestDigest);
    const manual = await context.call('/intakes', {
      collectionId: 'manual', sourceKey: 'm', revision: 'v1', contentBase64: 'eA==',
    });
    assert.equal(manual.status, 201);
  } finally { await context.close(); }
});
