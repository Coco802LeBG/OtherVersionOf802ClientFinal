'use strict';
// Mods depuis Modrinth (Fabric + version du profil). Chaque fichier est vérifié en SHA-512.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson, download, log } = require('./util');

const API = 'https://api.modrinth.com/v2';
const FABRIC_API_ID = 'P7dR8mSH';
const enc = encodeURIComponent;

async function search({ query = '', category = '', offset = 0, mcVersion }) {
  const facets = [['project_type:mod'], [`versions:${mcVersion}`], ['categories:fabric']];
  if (category) facets.push([`categories:${category}`]);
  const url = `${API}/search?query=${enc(query)}&facets=${enc(JSON.stringify(facets))}&limit=20&offset=${offset}&index=${query ? 'relevance' : 'downloads'}`;
  const r = await fetchJson(url);
  return {
    total: r.total_hits,
    hits: r.hits.map((h) => ({
      projectId: h.project_id, slug: h.slug, title: h.title, description: h.description,
      author: h.author, downloads: h.downloads, icon: h.icon_url || '', license: h.license || '',
      categories: h.display_categories || h.categories || [], clientSide: h.client_side, serverSide: h.server_side
    }))
  };
}

async function latestVersion(projectId, mcVersion) {
  const url = `${API}/project/${projectId}/version?game_versions=${enc(JSON.stringify([mcVersion]))}&loaders=${enc(JSON.stringify(['fabric']))}`;
  const list = await fetchJson(url);
  if (!list.length) return null;
  return list.find((v) => v.version_type === 'release') || list[0];
}

async function installProject(modsDir, profile, projectId, opts = {}, depth = 0) {
  if (depth > 6) return null;
  const mc = profile.mcVersion;
  const ver = await latestVersion(projectId, mc);
  if (!ver) throw new Error(`Aucune version Fabric ${mc} pour ce mod.`);
  const existing = profile.mods.find((m) => m.projectId === projectId);
  const file = ver.files.find((f) => f.primary) || ver.files[0];
  const filename = path.basename(file.filename);
  const dest = path.join(modsDir, filename);

  if (existing && existing.versionId === ver.id && fs.existsSync(dest)) return existing;

  const proj = await fetchJson(`${API}/project/${projectId}`);
  await fsp.mkdir(modsDir, { recursive: true });
  log(`Modrinth : ${proj.title} ${ver.version_number} (SHA-512 vérifié)`);
  await download(file.url, dest, { algo: 'sha512', hash: file.hashes.sha512 });
  if (existing && existing.filename !== filename) await fsp.rm(path.join(modsDir, existing.filename), { force: true });

  for (const d of ver.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id && d.project_id !== projectId) {
      await installProject(modsDir, profile, d.project_id, { dependency: true }, depth + 1);
    }
  }

  const rec = {
    projectId, slug: proj.slug, title: proj.title, versionId: ver.id, versionNumber: ver.version_number,
    filename, sha512: file.hashes.sha512, license: (proj.license && (proj.license.id || proj.license.name)) || '',
    dependency: !!opts.dependency, system: !!opts.system, source: 'modrinth'
  };
  const i = profile.mods.findIndex((m) => m.projectId === projectId);
  if (i >= 0) profile.mods[i] = { ...rec, dependency: profile.mods[i].dependency && rec.dependency }; else profile.mods.push(rec);
  return rec;
}

async function ensureFabricApi(modsDir, profile) {
  return installProject(modsDir, profile, FABRIC_API_ID, { dependency: true, system: true });
}

async function removeMod(modsDir, profile, projectId) {
  const m = profile.mods.find((x) => x.projectId === projectId);
  if (!m) return;
  await fsp.rm(path.join(modsDir, m.filename), { force: true });
  profile.mods = profile.mods.filter((x) => x.projectId !== projectId);
}

module.exports = { search, installProject, ensureFabricApi, removeMod, FABRIC_API_ID };
