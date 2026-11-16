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

  /** 同一作业的推进与移交串行化：移交边界不会切断正在收取的一页。 */
  serialize(jobId, operation) {
    const previous = this.pending.get(jobId) || Promise.resolve();
    const running = previous.catch(() => {}).then(operation);
    this.pending.set(jobId, running);
    running.catch(() => {}).finally(() => { if (this.pending.get(jobId) === running) this.pending.delete(jobId); });
    return running;
  }

  async start({ jobId, source, actor }) {
    identifier(jobId); identifier(actor);
    if (source !== this.origin) throw Object.assign(new Error('source_not_allowed'), { status: 403 });
    const ownership = await fetch(source + '/ownership', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, actor, expectedGeneration: 0 }) });
    if (ownership.status !== 200) throw Object.assign(new Error('ownership_conflict'), { status: 409 });
    const lease = await ownership.json();
    const opened = await this.openSession(source, '/open', lease, actor, jobId, 0);
    return this.save({ jobId, source, actor, generation: lease.generation, state: 'active', cursor: opened.cursor, lastCommitted: 0, received: [] });
  }

  async openSession(source, resumePath, lease, actor, jobId, after) {
    const response = await fetch(source + resumePath + (resumePath.includes('?') ? '&' : '?') + 'after=' + after, {
      headers: { 'x-collector': actor, 'x-job': jobId, 'x-generation': String(lease.generation) }
    });
    if (!response.ok) throw Object.assign(new Error('source_open_failed'), { status: 502 });
    return response.json();
  }

  async advance(jobId) {
    identifier(jobId);
    return this.serialize(jobId, async () => {
      const state = await this.read(jobId);
      if (state.state === 'handed-off') {
        throw Object.assign(new Error('job_handed_off'), { status: 409 });
      }
      if (state.state !== 'active') return state;
      const headers = { 'x-collector': state.actor, 'x-job': state.jobId, 'x-generation': String(state.generation) };
      const response = await fetch(state.source + state.cursor, { headers });
      if (!response.ok) throw Object.assign(new Error('source_cursor_' + response.status), { status: 502 });
      const page = await response.json();
      // 重叠补领：已确认条目直接跳过，不重复领取原文、不重复登记记录。
      const freshItems = page.items.filter(item => !state.received.includes(item.id));
      for (const item of freshItems) {
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
  }

  async fetchCatalog(source) {
    let response;
    try {
      response = await retrieve(source + '/catalog', this.origin);
    } catch (error) {
      throw Object.assign(new Error('source_catalog_unavailable'), { status: 502 });
    }
    let catalog;
    try { catalog = JSON.parse(response.bytes); }
    catch { throw Object.assign(new Error('source_catalog_invalid'), { status: 502 }); }
    if (typeof catalog.logicalSourceId !== 'string' || !catalog.logicalSourceId
      || typeof catalog.resume !== 'string' || typeof catalog.ownership !== 'string') {
      throw Object.assign(new Error('source_catalog_invalid'), { status: 502 });
    }
    return catalog;
  }

  async claimOwnership(source, jobId, actor, expectedGeneration, transferId) {
    const response = await fetch(source + '/ownership', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, actor, expectedGeneration, transferId })
    });
    if (response.status === 409) throw Object.assign(new Error('ownership_conflict'), { status: 409 });
    if (!response.ok) throw Object.assign(new Error('ownership_unavailable'), { status: 502 });
    return response.json();
  }

  /**
   * 导出可移交进度包。先等待本作业在途页面全部落盘，再冻结并持久化交接围栏；
   * 包内含全部已收件原文、出处与待领取范围，不含会话凭据与临时游标。
   */
  async exportJob(jobId) {
    identifier(jobId);
    return this.serialize(jobId, async () => {
      const state = await this.read(jobId);
      // 已围栏的作业不可再推进，但运维在来源侧重新协调资格后可再次导出新进度包。
      if (state.state !== 'active' && state.state !== 'completed' && state.state !== 'handed-off') {
        throw Object.assign(new Error('job_not_exportable'), { status: 409 });
      }
      const catalog = await this.fetchCatalog(state.source);
      // 围栏后来源资格可能已被运维协调；重新导出时以来源当前代次为准，
      // 使新进度包仍能通过导入端的代次核对。
      if (state.state === 'handed-off') {
        const ownershipResponse = await fetch(state.source + '/ownership?jobId=' + encodeURIComponent(state.jobId));
        if (!ownershipResponse.ok) throw Object.assign(new Error('ownership_unavailable'), { status: 502 });
        const ownership = await ownershipResponse.json();
        state.generation = ownership.generation;
        state.actor = ownership.actor;
      }
      const collection = await this.archive.collection(jobId);
      const carried = [];
      for (const receiptId of collection.receiptIds) {
        const receipt = await this.archive.receipt(receiptId);
        carried.push({ receipt, bytes: await this.archive.body(receiptId) });
      }
      const bundle = buildBundle({ state, collection, carried, catalog });
      const fenced = {
        jobId: state.jobId, source: state.source, actor: state.actor, generation: state.generation,
        state: 'handed-off', cursor: null, lastCommitted: state.lastCommitted,
        received: [...state.received], transferId: bundle.transferId,
        transferredAt: bundle.exportedAt
      };
      await this.save(fenced);
      return { transferId: bundle.transferId, logicalSourceId: catalog.logicalSourceId,
        lastCommitted: fenced.lastCommitted, received: [...fenced.received], bundle };
    });
  }

  /**
   * 导入进度包：先做包完整性与逻辑来源核对，再向来源按代次 CAS 取得接管资格，
   * 最后建立新会话并落盘。资格未取得绝不落地新作业；同包重复导入由来源代次仲裁为 409。
   */
  async importJob({ bundle, source, actor, verifyOnly = false }) {
    if (typeof source !== 'string' || !source) throw Object.assign(new Error('missing_source'), { status: 400 });
    if (actor !== undefined) identifier(actor);
    if (!verifyOnly && typeof actor !== 'string') throw Object.assign(new Error('missing_actor'), { status: 400 });
    if (source !== this.origin) throw Object.assign(new Error('source_not_allowed'), { status: 403 });
    const { payload, report } = verifyBundle(bundle);
    const catalog = await this.fetchCatalog(source);
    const sourceMatches = catalog.logicalSourceId === payload.source.logicalSourceId;

    const currentResponse = await fetch(source + '/ownership?jobId=' + encodeURIComponent(payload.job.jobId));
    if (!currentResponse.ok) throw Object.assign(new Error('ownership_unavailable'), { status: 502 });
    const current = await currentResponse.json();
    const generationMatches = current.generation === payload.job.generation;
    const eligible = sourceMatches && generationMatches;
    const verification = {
      ...report,
      sourceAddress: source,
      catalogLogicalSourceId: catalog.logicalSourceId,
      sourceMatches,
      expectedGeneration: payload.job.generation,
      currentGeneration: current.generation,
      currentActor: current.actor,
      generationMatches
    };
    if (verifyOnly) return { importable: eligible, verification };
    if (!sourceMatches) throw Object.assign(new Error('logical_source_mismatch'), { status: 400 });
    if (!generationMatches) throw Object.assign(new Error('ownership_conflict'), { status: 409 });

    try {
      await this.read(payload.job.jobId);
      throw Object.assign(new Error('job_already_imported'), { status: 409 });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    // 先在新归档复原原文与出处；失败时尚未向来源主张接管，旧环境仍可继续。
    await this.archive.restoreBundle(payload.archive);
    const lease = await this.claimOwnership(source, payload.job.jobId, actor, payload.job.generation, payload.transferId);
    const opened = await this.openSession(source, payload.source.resume, lease, actor, payload.job.jobId, payload.job.lastCommitted);
    const state = {
      jobId: payload.job.jobId, source, actor, generation: lease.generation,
      state: payload.job.state === 'completed' ? 'completed' : 'active',
      cursor: opened.cursor, lastCommitted: payload.job.lastCommitted,
      received: [...payload.job.received], transferId: payload.transferId, importedAt: new Date().toISOString()
    };
    await this.save(state);
    return { jobId: state.jobId, transferId: state.transferId, generation: state.generation,
      state: state.state, lastCommitted: state.lastCommitted, received: [...state.received],
      sourceMatches, generationMatches, receipts: report.receipts, records: report.records };
  }
}
