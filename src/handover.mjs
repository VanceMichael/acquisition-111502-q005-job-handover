import { randomUUID } from 'node:crypto';
import { digest, identifier } from './archive.mjs';

export const HANDOVER_FORMAT = 'receiver-job-handover';
export const HANDOVER_VERSION = 1;

function failure(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

export function hashPayload(payload) {
  return digest(Buffer.from(JSON.stringify(payload)));
}

/**
 * 形成可移交进度包：payload 为全部业务内容，integrity 覆盖 payload 的规范序列化，
 * 包内只出现逻辑身份、收件出处与原文字节，不携带会话凭据、临时游标或本机路径。
 */
export function buildBundle({ state, collection, carried, catalog }) {
  const transferId = 'transfer-' + randomUUID();
  const entries = carried.map(({ receipt, bytes }) => ({
    receiptId: receipt.receiptId,
    receipt,
    contentBase64: bytes.toString('base64')
  }));
  const manifest = entries.map(entry => ({
    receiptId: entry.receiptId,
    sha256: entry.receipt.sha256,
    byteLength: entry.receipt.byteLength
  }));
  const received = [...state.received];
  const payload = {
    format: HANDOVER_FORMAT,
    bundleVersion: HANDOVER_VERSION,
    transferId,
    exportedAt: new Date().toISOString(),
    source: {
      logicalSourceId: catalog.logicalSourceId,
      itemCount: catalog.itemCount,
      resume: catalog.resume,
      ownership: catalog.ownership
    },
    job: {
      jobId: state.jobId,
      state: state.state === 'completed' ? 'completed' : 'active',
      generation: state.generation,
      lastCommitted: state.lastCommitted,
      received,
      pending: {
        after: state.lastCommitted,
        resumePath: catalog.resume,
        knownItemCount: catalog.itemCount,
        remaining: Math.max(0, Number(catalog.itemCount) - received.length)
      }
    },
    archive: {
      collectionId: collection.collectionId,
      receiptIds: [...collection.receiptIds],
      records: collection.records,
      issues: collection.issues,
      manifest,
      entries
    }
  };
  return { ...payload, integrity: { algorithm: 'sha256', sha256: hashPayload(payload) } };
}

function assert(condition, code, message) {
  if (!condition) throw failure(code, message);
}

/**
 * 核对进度包：顶层完整性、原文字节、收件身份、出处闭环与进度一致性。
 * 任何缺失或改动都以 400 明确拒绝，返回可供运维查看的核对摘要。
 */
export function verifyBundle(bundle) {
  assert(bundle && typeof bundle === 'object' && !Array.isArray(bundle), 'invalid_bundle', '进度包不是有效对象');
  assert(bundle.format === HANDOVER_FORMAT, 'unsupported_bundle', '进度包格式不受支持');
  assert(bundle.bundleVersion === HANDOVER_VERSION, 'unsupported_bundle', '进度包版本不受支持');
  const { integrity, ...payload } = bundle;
  assert(integrity && integrity.algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(integrity.sha256),
    'bundle_integrity', '进度包完整性声明缺失或无效');
  assert(hashPayload(payload) === integrity.sha256, 'bundle_integrity', '进度包完整性校验失败，内容可能被改动');

  assert(payload.source && typeof payload.source.logicalSourceId === 'string' && payload.source.logicalSourceId,
    'invalid_bundle', '进度包缺少逻辑来源身份');
  assert(payload.job && typeof payload.job.jobId === 'string', 'invalid_bundle', '进度包缺少作业身份');
  identifier(payload.job.jobId);
  assert(Number.isInteger(payload.job.generation) && payload.job.generation >= 0, 'invalid_bundle', '进度包代次无效');
  assert(Number.isInteger(payload.job.lastCommitted) && payload.job.lastCommitted >= 0, 'invalid_bundle', '进度包水位无效');
  assert(Array.isArray(payload.job.received), 'invalid_bundle', '进度包缺少已接收范围');
  assert(['active', 'completed'].includes(payload.job.state), 'invalid_bundle', '进度包作业状态无效');

  const archive = payload.archive;
  assert(archive && typeof archive === 'object', 'invalid_bundle', '进度包缺少归档段');
  assert(archive.collectionId === payload.job.jobId, 'bundle_progress_mismatch', '进度包资料集与作业不一致');
  identifier(archive.collectionId);
  assert(Array.isArray(archive.receiptIds) && Array.isArray(archive.records) && Array.isArray(archive.issues)
    && Array.isArray(archive.manifest) && Array.isArray(archive.entries), 'invalid_bundle', '进度包归档段结构不完整');

  const entriesById = new Map();
  let byteLengthTotal = 0;
  for (const entry of archive.entries) {
    assert(entry && typeof entry.receiptId === 'string' && /^[a-f0-9]{64}$/.test(entry.receiptId),
      'invalid_bundle', '进度包含件身份无效');
    assert(entry.receipt && typeof entry.receipt === 'object', 'invalid_bundle', '进度包含件缺少收件元数据');
    const receipt = entry.receipt;
    assert(receipt.receiptId === entry.receiptId, 'bundle_tampered', '收件标识与含件标识不一致');
    assert(receipt.collectionId === archive.collectionId, 'bundle_tampered', '收件资料集归属被改动');
    for (const field of ['sourceKey', 'revision', 'mediaType', 'sha256']) {
      assert(typeof receipt[field] === 'string' && receipt[field], 'bundle_tampered', '收件元数据字段缺失或被改动');
    }
    assert(/^[a-f0-9]{64}$/.test(receipt.sha256), 'bundle_tampered', '收件摘要无效');
    const expectedReceiptId = digest(Buffer.from(JSON.stringify([receipt.collectionId, receipt.sourceKey, receipt.revision])));
    assert(expectedReceiptId === receipt.receiptId, 'bundle_tampered', '收件身份与出处/修订不再匹配');
    assert(typeof entry.contentBase64 === 'string', 'bundle_incomplete', '进度包缺少原文字节');
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    assert(digest(bytes) === receipt.sha256, 'bundle_tampered', '原文字节与收件摘要不一致');
    assert(Number.isInteger(receipt.byteLength) && receipt.byteLength === bytes.length, 'bundle_tampered', '原文长度被改动');
    assert(!entriesById.has(entry.receiptId), 'invalid_bundle', '进度包含件重复');
    entriesById.set(entry.receiptId, entry);
    byteLengthTotal += bytes.length;
  }

  assert(archive.manifest.length === archive.entries.length, 'bundle_incomplete', '清单与含件数量不一致');
  for (const item of archive.manifest) {
    const entry = entriesById.get(item.receiptId);
    assert(entry, 'bundle_incomplete', '清单引用了缺失的原文含件');
    assert(item.sha256 === entry.receipt.sha256 && item.byteLength === entry.receipt.byteLength,
      'bundle_tampered', '清单与收件元数据不一致');
  }
  for (const receiptId of archive.receiptIds) {
    assert(entriesById.has(receiptId), 'bundle_incomplete', '资料集引用了未随包移交的收件');
  }
  for (const record of archive.records) {
    assert(record && typeof record.kind === 'string' && typeof record.key === 'string', 'invalid_bundle', '记录结构无效');
    assert(Array.isArray(record.provenance) && record.provenance.length > 0, 'bundle_incomplete', '记录缺少出处');
    for (const origin of record.provenance) {
      assert(origin && typeof origin.location === 'string' && origin.location, 'bundle_incomplete', '出处定位无效');
      assert(entriesById.has(origin.receiptId), 'bundle_incomplete', '记录引用了未随包移交的收件');
    }
  }

  const collectedIds = archive.records
    .filter(record => record.kind === 'collected-item')
    .map(record => record.value && record.value.id)
    .sort();
  assert(collectedIds.every(Boolean), 'bundle_progress_mismatch', 'collected-item 记录缺少条目身份');
  const receivedIds = [...payload.job.received].sort();
  assert(JSON.stringify(collectedIds) === JSON.stringify(receivedIds), 'bundle_progress_mismatch',
    '已接收范围与 collected-item 记录不一致');

  const report = {
    transferId: payload.transferId,
    jobId: payload.job.jobId,
    state: payload.job.state,
    lastCommitted: payload.job.lastCommitted,
    received: [...payload.job.received],
    pending: { ...payload.job.pending },
    logicalSourceId: payload.source.logicalSourceId,
    receipts: entriesById.size,
    records: archive.records.length,
    issues: archive.issues.length,
    byteLengthTotal
  };
  return { payload, report };
}
