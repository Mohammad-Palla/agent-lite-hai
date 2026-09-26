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
};

const server = http.createServer((req, res) => {
  let filePath = path.join(UI_DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIR, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
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
