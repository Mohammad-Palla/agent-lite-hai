'use strict';
/**
 * Start All Services
 * Spawns:
 *   1. Storefront (Real :3003, Sandbox :3004)
 *   2. Gateway (:3001) & Admin/WebSocket (:3002)
 *   3. UI Dashboard (:3000)
 */

const { fork } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  AgentQuarantine — TrueForge Hackathon Gateway Harness');
console.log('═══════════════════════════════════════════════════════════════');

const services = [
  { name: 'STOREFRONT', file: path.join(root, 'storefront', 'server.js') },
  { name: 'GATEWAY',    file: path.join(root, 'gateway', 'server.js') },
  { name: 'UI',         file: path.join(root, 'ui', 'server.js') },
];

const children = [];

services.forEach(svc => {
  const child = fork(svc.file, [], { stdio: 'inherit' });
  children.push(child);
  console.log(`[SPAWN] ${svc.name} process running (PID: ${child.pid})`);
});

console.log('\nAll services running!');
console.log('  ▶ Retro Arcade Dashboard: http://localhost:3005');
console.log('  ▶ Gateway Proxy:          http://localhost:3001');
console.log('  ▶ Admin API & WebSockets: http://localhost:3002');
console.log('  ▶ Storefront Real:        http://localhost:3003');
console.log('  ▶ Storefront Sandbox:     http://localhost:3004');
console.log('\nPress Ctrl+C to shut down all processes.\n');

function shutdown() {
  console.log('\nShutting down services...');
  children.forEach(c => c.kill('SIGTERM'));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
