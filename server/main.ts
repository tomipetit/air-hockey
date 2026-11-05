// 本番/開発用サーバー：dist/ の静的配信 + /ws シグナリング + /healthz
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { attachSignaling } from './signaling';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? 'dist');
const hasStatic = existsSync(path.join(STATIC_DIR, 'index.html'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.resolve(STATIC_DIR, '.' + pathname);
  // ディレクトリトラバーサル防止
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!isFile(file)) file = path.join(STATIC_DIR, 'index.html');
  const ext = path.extname(file).toLowerCase();
  const immutable = pathname.startsWith('/assets/') && file !== path.join(STATIC_DIR, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if (req.url === '/healthz' || req.url?.startsWith('/healthz?')) return; // signaling 側が応答
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (!hasStatic) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('static files are not served (STATIC_DIR not found). Use Vite on :5173 during development.');
    return;
  }
  serveStatic(req, res);
});

attachSignaling(server);

server.listen(PORT, HOST, () => {
  console.log(
    `[server] http://${HOST}:${PORT}  ws: /ws  static: ${hasStatic ? STATIC_DIR : '(none)'}`,
  );
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
