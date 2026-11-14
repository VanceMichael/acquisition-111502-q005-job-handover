import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import routes from '../fixtures/routes.json' with { type: 'json' };

export function createProvider({ stage = 'complete' } = {}) {
  const requests = [];
  const counters = new Map();
  const issuedLeases = new Map();
  const owners = new Map();
  const cursors = new Map();
  let tokenSequence = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers });
    if (url.pathname === '/ownership') {
      const jobId = url.searchParams.get('jobId');
      if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(owners.get(jobId) || { generation: 0, actor: null })); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = '';
      for await (const chunk of request) body += chunk;
      const value = JSON.parse(body);
      const current = owners.get(value.jobId) || { generation: 0, actor: null };
      if (current.generation !== value.expectedGeneration) { response.writeHead(409); response.end('ownership_conflict'); return; }
      const next = { generation: current.generation + 1, actor: value.actor, transferId: value.transferId || null };
      owners.set(value.jobId, next);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(next)); return;
    }
    if (url.pathname === '/open' || url.pathname.startsWith('/cursor/')) {
      const actor = request.headers['x-collector'];
      const jobId = request.headers['x-job'];
      const generation = Number(request.headers['x-generation']);
      const current = owners.get(jobId);
      if (request.method !== 'GET' || !current || current.actor !== actor || current.generation !== generation) { response.writeHead(409); response.end('stale_owner'); return; }
      const issue = index => {
        const cursor = '/cursor/' + actor + '/' + String(++tokenSequence);
        cursors.set(cursor, { actor, generation, jobId, index });
        return cursor;
      };
      if (url.pathname === '/open') {
        const after = Number(url.searchParams.get('after') || 0);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ cursor: issue(Math.max(1, after)) })); return;
      }
      const cursor = cursors.get(url.pathname);
      if (!cursor || cursor.actor !== actor || cursor.generation !== generation || cursor.jobId !== jobId) { response.writeHead(410); response.end('cursor_expired'); return; }
      cursors.delete(url.pathname);
      const index = cursor.index;
      const page = { items: [{ id: 'r' + index, sequence: index, href: '/objects/r' + index }], next: index < 3 ? issue(index + 1) : null };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(page)); return;
    }
    const leased = url.pathname.match(/^\/leased\/([^/]+)\/(\d+)$/);
    if (leased) {
      const token = url.pathname;
      const issued = issuedLeases.get(token);
      if (!issued || issued.used) { response.writeHead(410); response.end('expired'); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end('read_only'); return; }
      issued.used = true;
      const bytes = await readFile(new URL('../fixtures/' + issued.file, import.meta.url));
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"log-' + issued.job + '"' });
      response.end(bytes); return;
    }
    const originalRoute = routes[url.pathname];
    const route = originalRoute ? { ...originalRoute, ...(originalRoute.stages?.[stage] || {}) } : undefined;
    if (!route || (route.availableAt && route.availableAt !== stage)) {
      response.writeHead(404); response.end('not_found'); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405); response.end('read_only'); return;
    }
    const count = (counters.get(url.pathname) || 0) + 1;
    counters.set(url.pathname, count);
    if (route.leaseJob) {
      const path = '/leased/' + route.leaseJob + '/' + count;
      issuedLeases.set(path, { file: route.file, job: route.leaseJob, used: false });
      const bytes = Buffer.from(JSON.stringify({ job: route.leaseJob, href: path }));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(bytes); return;
    }
    if (route.redirect) {
      response.writeHead(302, { location: route.redirect }); response.end(); return;
    }
    try {
      const fixture = stage === 'partial' && route.partialFile ? route.partialFile : route.file;
      let bytes = await readFile(new URL('../fixtures/' + fixture, import.meta.url));
      if (route.echoQuery) bytes = Buffer.from(JSON.stringify({ received: Object.fromEntries(url.searchParams), items: [{ id: 'item-selected' }] }));
      if (route.expireAfter && count > route.expireAfter) {
        response.writeHead(410); response.end('expired'); return;
      }
      const tag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
      const headers = { 'content-type': route.mediaType || 'application/octet-stream', etag: tag, 'accept-ranges': 'bytes', ...(route.headers || {}) };
      if (request.headers['if-none-match'] === tag) { response.writeHead(304, headers); response.end(); return; }
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start >= bytes.length || end < start) { response.writeHead(416); response.end(); return; }
        headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
        bytes = bytes.subarray(start, end + 1);
        headers['content-length'] = bytes.length;
        response.writeHead(206, headers);
      } else {
        headers['content-length'] = bytes.length;
        response.writeHead(200, headers);
      }
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(500); response.end('provider_file_error');
    }
  });
  return { server, requests };
}
