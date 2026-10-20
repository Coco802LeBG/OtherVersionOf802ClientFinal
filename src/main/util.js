'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');

// ---------- Logs (avec masquage des secrets) ----------
let sink = () => {};
const secrets = new Set();
function setLogSink(fn) { sink = fn; }
function addSecret(s) { if (s && String(s).length > 6) secrets.add(String(s)); }
function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}
function log(msg, level = 'info') {
  const line = redact(msg);
  try { sink(line, level); } catch (_) {}
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${line}`);
}

// ---------- Réseau ----------
const UA = config.USER_AGENT;
async function fetchRaw(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) }
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) {}
    const err = new Error(`HTTP ${res.status} sur ${url} ${body.slice(0, 300)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res;
}
async function fetchJson(url, opts = {}) {
  const res = await fetchRaw(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  return res.json();
}
async function fetchText(url, opts = {}) {
  const res = await fetchRaw(url, opts);
  return res.text();
}

// ---------- Hash ----------
function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
async function fileMatches(file, algo, expected) {
  try {
    await fsp.access(file);
    if (!expected) return true;
    return (await hashFile(file, algo)) === String(expected).toLowerCase();
  } catch (_) { return false; }
}

// ---------- Téléchargement vérifié ----------
// Retourne true si le fichier a été téléchargé, false s'il était déjà correct.
async function download(url, dest, { algo = 'sha1', hash = null, retries = 3, force = false } = {}) {
  if (!force && hash && (await fileMatches(dest, algo, hash))) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchRaw(url);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      if (hash) {
        const got = await hashFile(tmp, algo);
        if (got !== String(hash).toLowerCase()) {
          throw new Error(`Hash ${algo} incorrect pour ${path.basename(dest)} (attendu ${hash}, reçu ${got})`);
        }
      }
      await fsp.rename(tmp, dest);
      return true;
    } catch (e) {
      lastErr = e;
      try { await fsp.rm(tmp, { force: true }); } catch (_) {}
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ---------- Divers ----------
function mavenPath(name) {
  // group:artifact:version[:classifier][@ext]
  let ext = 'jar';
  let n = name;
  if (n.includes('@')) { [n, ext] = n.split('@'); }
  const [group, artifact, version, classifier] = n.split(':');
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}
function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profil';
}

module.exports = {
  setLogSink, addSecret, log, fetchRaw, fetchJson, fetchText, hashFile, fileMatches,
  download, mapLimit, mavenPath, osName, splitArgs, slug
};
