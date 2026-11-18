import { createHash } from 'node:crypto';
import { digest, identifier } from './archive.mjs';

export const BUNDLE_SCHEMA_VERSION = 1;

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameSet(left, right) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function integrityFail(reason) {
  return Object.assign(new Error('bundle_integrity_failed'), { status: 400, reason });
}

// 由本机持久状态与归档构建可移交进度包：只含可证明已接收的原文、出处与待续水位，
// 不携带 sessionToken、临时 cursor、绝对工作目录等环境绑定信息。
export async function buildBundle({ state, archive, logicalSourceId }) {
  const jobId = identifier(state.jobId);
  const collection = await archive.collection(jobId);
  const receipts = [];
  const blobs = new Map();
  for (const receiptId of collection.receiptIds) {
    const receipt = await archive.receipt(receiptId);
    receipts.push(receipt);
    if (!blobs.has(receipt.sha256)) blobs.set(receipt.sha256, await archive.body(receiptId));
  }
  const records = collection.records;
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    jobId,
    logicalSourceId,
    ownershipGeneration: state.generation,
    lastCommitted: state.lastCommitted,
    received: [...state.received],
    blobDigests: [...blobs.keys()].sort(),
    receiptIds: [...collection.receiptIds].sort(),
    recordDigests: records.map(record => sha256Json(record)),
  };
  const manifestDigest = sha256Json(manifest);
  const transferId = sha256Json({
    kind: 'job-handover', jobId, logicalSourceId,
    ownershipGeneration: state.generation, lastCommitted: state.lastCommitted, manifestDigest,
  });
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    transferId,
    exportedAt: state.exportedAt,
    job: {
      jobId,
      state: state.exportedFrom === 'completed' ? 'completed' : 'active',
      lastCommitted: state.lastCommitted,
      received: [...state.received],
    },
    source: { origin: state.source, logicalSourceId },
    ownership: { generation: state.generation },
    collection: { collectionId: jobId, receiptIds: [...collection.receiptIds] },
    receipts,
    blobs: [...blobs.entries()].map(([sha256, bytes]) => ({ sha256, contentBase64: bytes.toString('base64') })),
    records,
    manifest,
    integrity: { algorithm: 'sha256', manifestDigest },
  };
}

// 导入前的完整自校验：清单摘要、原文字节、收件身份、记录出处与作业水位互相印证，
// 任一缺失或改动都拒绝接管。返回运维可核对的接管摘要。
export function verifyBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw integrityFail('shape');
  if (bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw integrityFail('schema_version');
  if (bundle.sessionToken || bundle.cursor || bundle.job?.cursor || bundle.job?.sessionToken) {
    throw integrityFail('environment_bound_data');
  }
  const { manifest, integrity } = bundle;
  if (!manifest || !integrity || integrity.algorithm !== 'sha256' || sha256Json(manifest) !== integrity.manifestDigest) {
    throw integrityFail('manifest_digest');
  }
  for (const field of ['job', 'source', 'ownership', 'collection', 'receipts', 'blobs', 'records']) {
    if (!bundle[field] || typeof bundle[field] !== 'object') throw integrityFail(field + '_shape');
  }
  const jobId = identifier(bundle.job.jobId);
  if (manifest.jobId !== jobId || bundle.collection.collectionId !== jobId) throw integrityFail('job_id_scope');
  if (!['active', 'completed'].includes(bundle.job.state)) throw integrityFail('job_state');
  if (bundle.job.lastCommitted !== manifest.lastCommitted) throw integrityFail('watermark');
  if (!sameSet(bundle.job.received, manifest.received)) throw integrityFail('received_list');
  if (bundle.ownership.generation !== manifest.ownershipGeneration) throw integrityFail('ownership_generation');
  if (bundle.source.logicalSourceId !== manifest.logicalSourceId || typeof bundle.source.logicalSourceId !== 'string') {
    throw integrityFail('logical_source');
  }

  const blobDigests = new Set();
  for (const blob of bundle.blobs) {
    if (typeof blob?.sha256 !== 'string' || typeof blob.contentBase64 !== 'string') throw integrityFail('blob_shape');
    const bytes = Buffer.from(blob.contentBase64, 'base64');
    if (sha256Bytes(bytes) !== blob.sha256) throw integrityFail('blob_digest');
    blobDigests.add(blob.sha256);
  }
  if (!sameSet([...blobDigests].sort(), manifest.blobDigests)) throw integrityFail('blob_manifest');

  const receiptIds = new Set();
  for (const receipt of bundle.receipts) {
    if (receipt.collectionId !== jobId) throw integrityFail('receipt_collection_scope');
    const expectedId = digest(Buffer.from(JSON.stringify([receipt.collectionId, receipt.sourceKey, receipt.revision])));
    if (expectedId !== receipt.receiptId) throw integrityFail('receipt_identity');
    if (!blobDigests.has(receipt.sha256)) throw integrityFail('receipt_blob_missing');
    receiptIds.add(receipt.receiptId);
  }
  if (!sameSet([...receiptIds].sort(), manifest.receiptIds)) throw integrityFail('receipt_manifest');
  if (!sameSet(bundle.collection.receiptIds, manifest.receiptIds)) throw integrityFail('collection_manifest');

  if (!Array.isArray(bundle.records) || bundle.records.length !== manifest.recordDigests.length) {
    throw integrityFail('records_shape');
  }
  bundle.records.forEach((record, index) => {
    if (sha256Json(record) !== manifest.recordDigests[index]) throw integrityFail('record_digest');
    if (!Array.isArray(record.provenance) || record.provenance.length === 0) throw integrityFail('record_provenance');
    for (const origin of record.provenance) {
      if (!receiptIds.has(origin.receiptId) || typeof origin.location !== 'string' || !origin.location) {
        throw integrityFail('provenance_scope');
      }
    }
    if (record.kind === 'collected-item' && !bundle.job.received.includes(record.value?.id)) {
      throw integrityFail('record_watermark');
    }
  });

  const transferId = sha256Json({
    kind: 'job-handover', jobId, logicalSourceId: manifest.logicalSourceId,
    ownershipGeneration: manifest.ownershipGeneration, lastCommitted: manifest.lastCommitted,
    manifestDigest: integrity.manifestDigest,
  });
  if (transferId !== bundle.transferId) throw integrityFail('transfer_identity');

  return {
    jobId,
    transferId: bundle.transferId,
    logicalSourceId: bundle.source.logicalSourceId,
    resumeAfter: bundle.job.lastCommitted,
    received: [...bundle.job.received],
    jobState: bundle.job.state,
    ownershipGeneration: bundle.ownership.generation,
    restored: { receipts: bundle.receipts.length, blobs: bundle.blobs.length, records: bundle.records.length },
  };
}
