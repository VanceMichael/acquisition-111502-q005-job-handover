export function summarize(bytes) {
  try { const value = JSON.parse(bytes); return { format: 'job-source', sourceId: value.logicalSourceId || null, byteLength: bytes.length }; } catch { return { format: 'raw', byteLength: bytes.length }; }
}
