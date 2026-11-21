// Servidor HTTP estático mínimo (node:http) para os testes e2e. Porta livre escolhida pelo SO.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.ico': 'image/x-icon', '.wav': 'audio/wav'
};

export function startServer(root) {
  const base = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const file = path.resolve(base, '.' + p);
      if (!file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
