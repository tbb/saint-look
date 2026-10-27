#!/usr/bin/env node
// Deterministic local transport fixture. It does not classify, generate or segment images.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const image = readFileSync(new URL('../deploy/synthetic.png', import.meta.url)).toString('base64');
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || !['/attributes', '/generate', '/segment'].includes(request.url)) {
    response.writeHead(404); response.end(); return;
  }
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 24 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(request.url === '/attributes'
    ? { features: { silhouette: 'unknown', pattern: 'unknown', detail_visibility: 'unknown' } }
    : { pngBase64: image }));
});
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
