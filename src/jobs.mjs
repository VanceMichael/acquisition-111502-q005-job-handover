import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier } from './archive.mjs';
import { retrieve } from './transport.mjs';
import { buildBundle, verifyBundle } from './handover.mjs';

export class Jobs {
  constructor(directory, archive, origin) {
    this.directory = join(directory, 'jobs');
    this.archive = archive;
    this.origin = origin;
    this.pending = new Map();
  }

  async save(state) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, identifier(state.jobId) + '.json');
    const temporary = path + '.' + process.pid + '.pending';
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, path);
    return state;
  }

  async read(jobId) {
    try { return JSON.parse(await readFile(join(this.directory, identifier(jobId) + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('job_not_found'), { status: 404 }); throw error; }
  }

  async fetchLogicalSourceId(source) {
    const catalog = await retrieve(new URL('/catalog', source).href, this.origin);
    let parsed;
    try { parsed = JSON.parse(catalog.bytes); }
    catch { throw Object.assign(new Error('source_catalog_invalid'), { status: 502 }); }
    if (typeof parsed.logicalSourceId !== 'string' || !parsed.logicalSourceId) {
      throw Object.assign(new Error('source_catalog_invalid'), { status: 502 });
    }
    return parsed.logicalSourceId;
  }

  async start({ jobId, source, actor }) {
    identifier(jobId); identifier(actor);
    if (source !== this.origin) throw Object.assign(new Error('source_not_allowed'), { status: 403 });
    const ownership = await fetch(source + '/ownership', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, actor, expectedGeneration: 0 }) });
    if (ownership.status !== 200) throw Object.assign(new Error('ownership_conflict'), { status: 409 });
    const lease = await ownership.json();
    const response = await fetch(source + '/open?after=0', { headers: { 'x-collector': actor, 'x-job': jobId, 'x-generation': String(lease.generation) } });
    if (!response.ok) throw Object.assign(new Error('source_open_failed'), { status: 502 });
    const opened = await response.json();
    return this.save({ jobId, source, actor, generation: lease.generation, state: 'active', cursor: opened.cursor, lastCommitted: 0, received: [], sessionToken: 'session-' + actor });
  }

  // 移交边界：在作业自身的串行链上排空正在收取的一页后，再写入持久的 exported
  // 栅栏。因此不会漏掉进行中的那一页；栅栏落盘后旧进程即使重启也无法再发表结果。
  async export(jobId) {
    identifier(jobId);
    const previous = this.pending.get(jobId) || Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      const state = await this.read(jobId);
      if (state.state === 'exported' && state.exportedAt) {
        const logicalSourceId = await this.fetchLogicalSourceId(state.source);
        return { transferId: state.transferId, bundle: await buildBundle({ state, archive: this.archive, logicalSourceId }) };
      }
      if (state.state !== 'active' && state.state !== 'completed') {
        throw Object.assign(new Error('job_not_exportable'), { status: 409 });
      }
      const exportedFrom = state.state;
      state.exportedFrom = exportedFrom;
      state.state = 'exported';
      state.exportedAt = new Date().toISOString();
      const logicalSourceId = await this.fetchLogicalSourceId(state.source);
      await this.save(state);
      const bundle = await buildBundle({ state, archive: this.archive, logicalSourceId });
      state.transferId = bundle.transferId;
      await this.save(state);
      return { transferId: bundle.transferId, bundle };
    });
    this.pending.set(jobId, running);
    return running;
  }

  async import({ bundle, source, actor }) {
    if (!bundle || typeof bundle !== 'object') throw Object.assign(new Error('invalid_bundle'), { status: 400 });
    identifier(actor);
    let sourceUrl;
    try { sourceUrl = new URL(source); }
    catch { throw Object.assign(new Error('invalid_source'), { status: 400 }); }
    if (sourceUrl.origin !== this.origin) throw Object.assign(new Error('source_not_allowed'), { status: 403 });

    const summary = verifyBundle(bundle);
    const jobId = summary.jobId;
    const logicalSourceId = await this.fetchLogicalSourceId(source);
    if (logicalSourceId !== summary.logicalSourceId) {
      throw Object.assign(new Error('logical_source_mismatch'), { status: 409 });
    }

    let existing;
    try { existing = await this.read(jobId); }
    catch (error) { if (error.status !== 404) throw error; }
    if (existing) {
      // 同一接管者重放同一进度包：恢复导入的幂等重试，不得产生第二个接管者。
      if (existing.transferId === summary.transferId && existing.actor === actor && existing.imported) {
        await this.archive.restoreBundle(bundle);
        return { status: 201, jobId, transferId: summary.transferId, state: existing.state,
          resumeAfter: existing.lastCommitted, logicalSourceId, duplicate: true, restored: summary.restored };
      }
      throw Object.assign(new Error('job_already_claimed'), { status: 409 });
    }

    // 先向来源取得接管资格（代次 CAS），同包被另一 actor 再导入时代次不符返回409。
    const ownership = await fetch(source + '/ownership', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, actor, expectedGeneration: summary.ownershipGeneration, transferId: summary.transferId }),
    });
    if (ownership.status !== 200) throw Object.assign(new Error('ownership_conflict'), { status: 409 });
    const lease = await ownership.json();

    await this.archive.restoreBundle(bundle);
    const state = {
      jobId, source, actor, generation: lease.generation,
      state: summary.jobState, exportedFrom: summary.jobState,
      cursor: null, // 临时游标不跨环境；首次 advance 按水位重新 /open
      lastCommitted: summary.resumeAfter, received: summary.received,
      transferId: summary.transferId, imported: true, importedAt: new Date().toISOString(),
    };
    await this.save(state);
    return { status: 201, jobId, transferId: summary.transferId, state: state.state,
      resumeAfter: summary.resumeAfter, logicalSourceId, restored: summary.restored };
  }

  async openCursor(state) {
    const response = await fetch(state.source + '/open?after=' + state.lastCommitted, {
      headers: { 'x-collector': state.actor, 'x-job': state.jobId, 'x-generation': String(state.generation) },
    });
    if (!response.ok) throw Object.assign(new Error('source_open_failed'), { status: 502 });
    const opened = await response.json();
    state.cursor = opened.cursor;
  }

  async advance(jobId) {
    identifier(jobId);
    const previous = this.pending.get(jobId) || Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      const state = await this.read(jobId);
      // 移交栅栏是本机持久状态：旧进程重启后仍在此处被拒绝，迟到响应也无从发表。
      if (state.state === 'exported') throw Object.assign(new Error('job_handed_over'), { status: 409 });
      if (state.state !== 'active') return state;
      if (!state.cursor) await this.openCursor(state);
      const headers = { 'x-collector': state.actor, 'x-job': state.jobId, 'x-generation': String(state.generation) };
      const response = await fetch(state.source + state.cursor, { headers });
      if (response.status === 410) {
        // 迟到或已失效的游标（含旧会话残留）：按已确认水位重开会话，重叠项跳过，不丢页。
        await this.openCursor(state);
        return this.save(state);
      }
      if (!response.ok) throw Object.assign(new Error('source_cursor_' + response.status), { status: 502 });
      const page = await response.json();
      for (const item of page.items) {
        if (state.received.includes(item.id)) continue; // 重叠补领幂等，不重复发表资料
        const url = new URL(item.href, state.source);
        const raw = await retrieve(url.href, this.origin);
        const receipt = await this.archive.receive({ collectionId: jobId, sourceKey: url.href, revision: raw.revision, mediaType: raw.mediaType, bytes: raw.bytes, summary: { id: item.id } });
        const value = JSON.parse(raw.bytes);
        await this.archive.addRecord(jobId, { kind: 'collected-item', key: item.id, value: { id: item.id, sequence: item.sequence, payload: value }, provenance: [{ receiptId: receipt.receiptId, location: '/' }] });
        state.received.push(item.id);
        state.lastCommitted = Math.max(state.lastCommitted, item.sequence);
      }
      state.cursor = page.next;
      if (!page.next) state.state = 'completed';
      return this.save(state);
    });
    this.pending.set(jobId, running);
    return running;
  }
}
