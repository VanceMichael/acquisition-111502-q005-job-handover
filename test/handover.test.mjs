import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { Archive } from '../src/archive.mjs';
import { harness } from './harness.mjs';
import { hashPayload } from '../src/handover.mjs';

async function standaloneService(context, allowedOrigin = context.source) {
  const directory = await mkdtemp(join(tmpdir(), 'handover-'));
  const service = await createService({ directory, allowedOrigin });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  async function call(path, body) {
    const response = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  }
  async function close() {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  return { base, directory, call, close };
}

test('导出的进度包携带原文出处与待领范围且不含凭据和临时游标', async () => {
  const context = await harness();
  try {
    await context.call('/jobs', { jobId: 'pack', source: context.source, actor: 'node-a' });
    await context.call('/jobs/pack/advance', {});
    const exported = await context.call('/jobs/pack/export', {});
    assert.equal(exported.status, 200);
    const bundle = exported.value.bundle;
    assert.equal(bundle.format, 'receiver-job-handover');
    assert.equal(bundle.integrity.algorithm, 'sha256');
    assert.match(bundle.integrity.sha256, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes('session-'), '进度包泄露会话凭据');
    assert.ok(!serialized.includes('/cursor/'), '进度包泄露临时游标');
    assert.ok(!serialized.includes(context.directory), '进度包泄露本机工作目录');
    assert.equal(bundle.source.logicalSourceId, 'partner-catalog-1');
    assert.deepEqual(bundle.job.received, ['r1']);
    assert.equal(bundle.job.pending.after, 1);
    assert.equal(bundle.job.pending.remaining, 2);
    assert.ok(bundle.archive.entries.length >= 1);
    assert.ok(bundle.archive.records.some(record => record.kind === 'collected-item' && record.key === 'r1'));
    const entry = bundle.archive.entries[0];
    assert.match(entry.receipt.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.contentBase64.length > 0);
    const state = (await context.call('/jobs/pack')).value;
    assert.equal(state.state, 'handed-off');
    assert.equal(state.transferId, bundle.transferId);
    assert.equal(state.cursor, null);
    assert.ok(!('sessionToken' in state));
  } finally { await context.close(); }
});

test('跨环境接管后从重叠边界继续且不产生重复资料', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'cross', source: context.source, actor: 'node-a' });
    await context.call('/jobs/cross/advance', {});
    const bundle = (await context.call('/jobs/cross/export', {})).value.bundle;
    const imported = await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' });
    assert.equal(imported.status, 201);
    assert.deepEqual(imported.value.received, ['r1']);
    for (let count = 0; count < 6; count++) {
      const page = await destination.call('/jobs/cross/advance', {});
      assert.equal(page.status, 200);
      if (page.value.state === 'completed') break;
    }
    const collection = (await destination.call('/collections/cross')).value;
    const ids = collection.records.filter(record => record.kind === 'collected-item').map(record => record.value.id).sort();
    assert.deepEqual(ids, ['r1', 'r2', 'r3']);
    assert.equal(collection.receiptIds.length, 3, '重叠补领不应产生重复收件');
    for (const record of collection.records) {
      for (const origin of record.provenance) {
        assert.equal((await destination.call('/receipts/' + origin.receiptId)).status, 200);
      }
    }
    const moved = await destination.call('/jobs/cross');
    assert.equal(moved.value.state, 'completed');
    const ownership = await fetch(context.source + '/ownership?jobId=cross').then(response => response.json());
    assert.equal(ownership.actor, 'node-b');
    assert.equal(ownership.transferId, bundle.transferId);
  } finally { await destination.close(); await context.close(); }
});

test('旧进程重启后仍被围栏拒绝，迟到响应不能再发表结果', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'restart', source: context.source, actor: 'node-a' });
    await context.call('/jobs/restart/advance', {});
    const bundle = (await context.call('/jobs/restart/export', {})).value.bundle;
    assert.equal((await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' })).status, 201);
    assert.equal((await context.call('/jobs/restart/advance', {})).status, 409);
    await context.restart();
    const again = await context.call('/jobs/restart/advance', {});
    assert.equal(again.status, 409);
    assert.equal(again.value.error, 'job_handed_off');
    // 旧代次的来源请求已被来源拒绝，旧实例不会新增任何记录。
    assert.equal((await context.call('/collections/restart')).value.records.length, 1);
  } finally { await destination.close(); await context.close(); }
});

test('同一进度包重复导入只能有一个有效接管者', async () => {
  const context = await harness();
  const first = await standaloneService(context);
  const second = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'single', source: context.source, actor: 'node-a' });
    await context.call('/jobs/single/advance', {});
    const bundle = (await context.call('/jobs/single/export', {})).value.bundle;
    assert.equal((await first.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' })).status, 201);
    const rival = await second.call('/jobs/import', { bundle, source: context.source, actor: 'node-c' });
    assert.equal(rival.status, 409);
    assert.equal(rival.value.error, 'ownership_conflict');
    // 失败的接管不在第二个环境留下作业。
    assert.equal((await second.call('/jobs/single')).status, 404);
    // 同包再导回首个环境同样被拒绝。
    assert.equal((await first.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' })).status, 409);
  } finally { await first.close(); await second.close(); await context.close(); }
});

test('进度包被改动或原文缺失时完整性校验拒绝导入', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'tamper', source: context.source, actor: 'node-a' });
    await context.call('/jobs/tamper/advance', {});
    const original = (await context.call('/jobs/tamper/export', {})).value.bundle;

    const tampered = JSON.parse(JSON.stringify(original));
    tampered.job.lastCommitted = 99;
    assert.equal((await destination.call('/jobs/import', { bundle: tampered, source: context.source, actor: 'node-b' })).status, 400);

    const byteTampered = JSON.parse(JSON.stringify(original));
    byteTampered.archive.entries[0].contentBase64 = Buffer.from('被替换的内容').toString('base64');
    assert.equal((await destination.call('/jobs/import', { bundle: byteTampered, source: context.source, actor: 'node-b' })).status, 400);

    const stripped = JSON.parse(JSON.stringify(original));
    stripped.archive.entries = [];
    stripped.archive.manifest = [];
    stripped.integrity.sha256 = hashPayload((({ integrity, ...rest }) => rest)(stripped));
    const missing = await destination.call('/jobs/import', { bundle: stripped, source: context.source, actor: 'node-b' });
    assert.equal(missing.status, 400);
    // 校验失败不取得来源资格、不落地资料集。
    const collection = (await destination.call('/collections/tamper')).value;
    assert.deepEqual(collection.receiptIds, []);
    assert.deepEqual(collection.records, []);
    const ownership = await fetch(context.source + '/ownership?jobId=tamper').then(response => response.json());
    assert.equal(ownership.generation, original.job.generation);
  } finally { await destination.close(); await context.close(); }
});

test('逻辑来源不一致时拒绝接管，不能凭地址相似通过', async () => {
  const context = await harness();
  // 独立假来源：地址可达但 logicalSourceId 与进度包记录的不同。
  const fake = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/catalog') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ logicalSourceId: 'partner-catalog-OTHER', itemCount: 3, resume: '/open', ownership: '/ownership' }));
      return;
    }
    if (url.pathname === '/ownership') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ generation: 1, actor: 'node-a' }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const foreignSource = `http://127.0.0.1:${fake.address().port}`;
  const destination = await standaloneService(context, foreignSource);
  try {
    await context.call('/jobs', { jobId: 'logic', source: context.source, actor: 'node-a' });
    await context.call('/jobs/logic/advance', {});
    const bundle = (await context.call('/jobs/logic/export', {})).value.bundle;
    const result = await destination.call('/jobs/import', { bundle, source: foreignSource, actor: 'node-b' });
    assert.equal(result.status, 400);
    assert.equal(result.value.error, 'logical_source_mismatch');
    const ownership = await fetch(context.source + '/ownership?jobId=logic').then(response => response.json());
    assert.equal(ownership.actor, 'node-a');
  } finally { await destination.close(); await new Promise(resolve => fake.close(resolve)); await context.close(); }
});

test('只核对不接管：verify 返回适用性结论且不改变来源资格与本地状态', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'check', source: context.source, actor: 'node-a' });
    await context.call('/jobs/check/advance', {});
    const bundle = (await context.call('/jobs/check/export', {})).value.bundle;
    const report = await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b', verify: true });
    assert.equal(report.status, 200);
    assert.equal(report.value.importable, true);
    assert.equal(report.value.verification.sourceMatches, true);
    assert.equal(report.value.verification.generationMatches, true);
    assert.equal(report.value.verification.received.length, 1);
    const ownership = await fetch(context.source + '/ownership?jobId=check').then(response => response.json());
    assert.equal(ownership.actor, 'node-a');
    assert.equal((await destination.call('/jobs/check')).status, 404);
    // 核对后仍可正式接管。
    assert.equal((await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' })).status, 201);
    const stale = await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b', verify: true });
    assert.equal(stale.value.importable, false);
    assert.equal(stale.value.verification.generationMatches, false);
  } finally { await destination.close(); await context.close(); }
});

test('导出与在途收取串行：移交不会漏掉正在收取的一页', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'racing', source: context.source, actor: 'node-a' });
    const advance = context.call('/jobs/racing/advance', {});
    const exportCall = context.call('/jobs/racing/export', {});
    const [page, exported] = await Promise.all([advance, exportCall]);
    assert.equal(page.status, 200);
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.value.received, page.value.received);
    assert.equal(exported.value.bundle.job.received.length, page.value.received.length);
    assert.equal((await destination.call('/jobs/import', { bundle: exported.value.bundle, source: context.source, actor: 'node-b' })).status, 201);
    for (let count = 0; count < 6; count++) {
      const result = await destination.call('/jobs/racing/advance', {});
      if (result.value.state === 'completed') break;
    }
    const ids = (await destination.call('/collections/racing')).value.records.map(record => record.value.id).sort();
    assert.deepEqual(ids, ['r1', 'r2', 'r3']);
  } finally { await destination.close(); await context.close(); }
});

test('资格核对失败不落地作业，来源资格协调后新进度包可正常接管', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'retry', source: context.source, actor: 'node-a' });
    await context.call('/jobs/retry/advance', {});
    const bundle = (await context.call('/jobs/retry/export', {})).value.bundle;
    // 先让来源代次越过进度包记录的代次，模拟接管资格被他人抢先。
    const stolen = await fetch(context.source + '/ownership', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'retry', actor: 'node-z', expectedGeneration: 1, transferId: 'rival' }) });
    assert.equal(stolen.status, 200);
    const failed = await destination.call('/jobs/import', { bundle, source: context.source, actor: 'node-b' });
    assert.equal(failed.status, 409);
    assert.equal((await destination.call('/jobs/retry')).status, 404);
    const emptyCollection = (await destination.call('/collections/retry')).value;
    assert.deepEqual(emptyCollection.receiptIds, []);
    // 运维协调后由当前资格持有者在新代次重新导出，新进度包可正常接管。
    await fetch(context.source + '/ownership', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'retry', actor: 'node-a', expectedGeneration: 2 }) });
    const refreshed = (await context.call('/jobs/retry/export', {})).value.bundle;
    assert.equal(refreshed.job.generation, 3);
    const retry = await destination.call('/jobs/import', { bundle: refreshed, source: context.source, actor: 'node-b' });
    assert.equal(retry.status, 201);
    assert.equal((await destination.call('/jobs/retry')).value.lastCommitted, 1);
  } finally { await destination.close(); await context.close(); }
});

test('进度包原文落地可幂等重放且拒绝异己内容', async () => {
  const context = await harness();
  try {
    await context.call('/jobs', { jobId: 'idem', source: context.source, actor: 'node-a' });
    await context.call('/jobs/idem/advance', {});
    const bundle = (await context.call('/jobs/idem/export', {})).value.bundle;
    const directory = await mkdtemp(join(tmpdir(), 'restore-'));
    try {
      const target = new Archive(directory);
      await target.initialize();
      await target.restoreBundle(bundle.archive);
      await target.restoreBundle(bundle.archive);
      const collection = await target.collection('idem');
      assert.equal(collection.receiptIds.length, 1);
      assert.equal(collection.records.length, 1);
      const receipt = await target.receipt(collection.receiptIds[0]);
      assert.equal((await target.body(receipt.receiptId)).length, receipt.byteLength);
      const divergent = JSON.parse(JSON.stringify(bundle.archive));
      divergent.records[0] = { ...divergent.records[0], key: 'tampered' };
      await assert.rejects(() => target.restoreBundle(divergent), error => error.status === 409);
    } finally { await rm(directory, { recursive: true, force: true }); }
  } finally { await context.close(); }
});

test('已移交作业不能再次导出，完成态作业也可整体移交', async () => {
  const context = await harness();
  const destination = await standaloneService(context);
  try {
    await context.call('/jobs', { jobId: 'done', source: context.source, actor: 'node-a' });
    for (let count = 0; count < 3; count++) await context.call('/jobs/done/advance', {});
    const exported = await context.call('/jobs/done/export', {});
    assert.equal(exported.status, 200);
    assert.equal(exported.value.bundle.job.state, 'completed');
    // 围栏作业不能再推进，但允许重新导出进度包。
    assert.equal((await context.call('/jobs/done/advance', {})).status, 409);
    const reExported = await context.call('/jobs/done/export', {});
    assert.equal(reExported.status, 200);
    assert.notEqual(reExported.value.transferId, exported.value.transferId);
    const imported = await destination.call('/jobs/import', { bundle: exported.value.bundle, source: context.source, actor: 'node-b' });
    assert.equal(imported.status, 201);
    assert.equal(imported.value.state, 'completed');
    const collection = (await destination.call('/collections/done')).value;
    assert.equal(collection.records.length, 3);
  } finally { await destination.close(); await context.close(); }
});
