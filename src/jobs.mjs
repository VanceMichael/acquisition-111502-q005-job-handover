import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier } from './archive.mjs';
import { retrieve } from './transport.mjs';

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

  async advance(jobId) {
    identifier(jobId);
    const previous = this.pending.get(jobId) || Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      const state = await this.read(jobId);
      if (state.state !== 'active') return state;
      const headers = { 'x-collector': state.actor, 'x-job': state.jobId, 'x-generation': String(state.generation) };
      const response = await fetch(state.source + state.cursor, { headers });
      if (!response.ok) throw Object.assign(new Error('source_cursor_' + response.status), { status: 502 });
      const page = await response.json();
      for (const item of page.items) {
        const url = new URL(item.href, state.source);
        const raw = await retrieve(url.href, this.origin);
        const receipt = await this.archive.receive({ collectionId: jobId, sourceKey: url.href, revision: raw.revision, mediaType: raw.mediaType, bytes: raw.bytes, summary: { id: item.id } });
        const value = JSON.parse(raw.bytes);
        await this.archive.addRecord(jobId, { kind: 'collected-item', key: item.id, value: { id: item.id, sequence: item.sequence, payload: value }, provenance: [{ receiptId: receipt.receiptId, location: '/' }] });
        if (!state.received.includes(item.id)) state.received.push(item.id);
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
