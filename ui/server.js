'use strict';
/**
 * UI Dev Server — serves the single-page retro arcade dashboard on port 3005.
 * (Port 3000 is reserved by the IDE environment on this system).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = Number(process.env.UI_PORT || process.env.PORT || 3005);
const UI_DIR = path.join(__dirname);

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = (() => { try { return decodeURIComponent(req.url.split('?')[0].split('#')[0]); } catch (_) { return null; } })();
  if (urlPath === null || urlPath.includes('\0')) { res.writeHead(400); res.end('Bad request'); return; }

  // /config.js: where the gateway and admin API are, so browser pages need no hardcoded ports
  if (urlPath === '/config.js') {
    const gw = Number(process.env.GATEWAY_PORT) || 3001, admin = Number(process.env.ADMIN_PORT) || 3002;
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(`window.QUARANTINE = ${JSON.stringify({ gateway: `http://localhost:${gw}`, admin: `http://localhost:${admin}` })};`);
    return;
  }

  // Only ever serve files that live INSIDE this folder, and only known web file types.
  // (This used to join the raw URL onto the folder, so "/../.env" returned the project's secrets.)
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(UI_DIR, rel);
  const inside = filePath === UI_DIR || filePath.startsWith(UI_DIR + path.sep);
  const ext = path.extname(filePath).toLowerCase();
  const hidden = rel.split('/').some((seg) => seg.startsWith('.'));
  if (!inside || hidden || !MIME[ext] || path.basename(filePath) === 'server.js') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

let currentPort = DEFAULT_PORT;
let attempts = 0;
const MAX_ATTEMPTS = 5;

function startServer() {
  server.listen(currentPort, () => {
    console.log(`[UI] Dashboard available at http://localhost:${currentPort}`);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempts < MAX_ATTEMPTS) {
    attempts++;
    currentPort++;
    console.log(`[UI] Port in use, trying http://localhost:${currentPort}...`);
    setTimeout(startServer, 200);
  } else {
    console.error('[UI] Fatal server error:', err.message);
    process.exit(1);
  }
});

startServer();
