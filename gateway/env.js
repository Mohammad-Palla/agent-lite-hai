'use strict';
/**
 * Minimal .env loader (no dependency). Real environment variables win over the file.
 * Never logs values.
 */

const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const loaded = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (val === '') continue; // empty means "unset"
    if (process.env[m[1]] === undefined) { process.env[m[1]] = val; loaded.push(m[1]); }
  }
  return loaded;
}

module.exports = { loadEnv };
