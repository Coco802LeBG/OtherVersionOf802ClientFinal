'use strict';
// Récupère 802 Client depuis les Releases GitHub du mod (dépôt public). Hash SHA-256 vérifié.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { fetchJson, fetchText, download, hashFile, log } = require('./util');

async function latestRelease() {
  try {
    return await fetchJson(`https://api.github.com/repos/${config.CLIENT_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    });
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`Aucune release trouvée sur github.com/${config.CLIENT_REPO}. Publie un tag (ex. v1.0.0) dans le dépôt du mod (voir README).`);
    }
    throw e;
  }
}

function pickAsset(rel) {
  const jar = (rel.assets || []).find((a) => /^802-client.*\.jar$/i.test(a.name) && !/(sources|dev|javadoc)/i.test(a.name));
  if (!jar) throw new Error('La release ne contient pas de fichier 802-client-*.jar.');
  const sum = (rel.assets || []).find((a) => a.name === jar.name + '.sha256');
  return { jar, sum };
}

async function check(profile) {
  const rel = await latestRelease();
  const installed = profile.client ? profile.client.tag : null;
  return { installed, latest: rel.tag_name, updateAvailable: installed !== rel.tag_name, notes: rel.body || '' };
}

async function install(modsDir, profile) {
  const rel = await latestRelease();
  const { jar, sum } = pickAsset(rel);
  const dest = path.join(modsDir, jar.name);

  let expected = null;
  if (sum) expected = (await fetchText(sum.browser_download_url)).trim().split(/\s+/)[0].toLowerCase();
  else if (jar.digest && jar.digest.startsWith('sha256:')) expected = jar.digest.slice(7).toLowerCase();

  const upToDate = profile.client && profile.client.tag === rel.tag_name && fs.existsSync(dest);
  if (!upToDate) {
    await fsp.mkdir(modsDir, { recursive: true });
    log(`802 Client ${rel.tag_name} depuis github.com/${config.CLIENT_REPO}`);
    await download(jar.browser_download_url, dest, { algo: 'sha256', hash: expected, force: true });
    if (!expected) log('⚠ Aucun SHA-256 publié avec cette release : fichier non vérifié.', 'warn');
    if (profile.client && profile.client.filename && profile.client.filename !== jar.name) {
      await fsp.rm(path.join(modsDir, profile.client.filename), { force: true });
    }
  }
  profile.client = { tag: rel.tag_name, filename: jar.name, sha256: expected || (await hashFile(dest, 'sha256')) };
  return profile.client;
}

module.exports = { check, install };
