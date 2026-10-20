'use strict';
// Installation de Fabric Loader depuis meta.fabricmc.net et maven.fabricmc.net
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson, fetchText, download, mapLimit, mavenPath, log } = require('./util');

const META = 'https://meta.fabricmc.net/v2';

async function installFabric(paths, mcVersion, progress, pinnedLoader) {
  progress({ step: 'fabric', pct: 0, text: 'Recherche de Fabric Loader…' });
  const loaders = await fetchJson(`${META}/versions/loader/${mcVersion}`);
  if (!loaders.length) throw new Error(`Fabric ne supporte pas Minecraft ${mcVersion}.`);
  const pick = pinnedLoader
    ? loaders.find((l) => l.loader.version === pinnedLoader)
    : loaders.find((l) => l.loader.stable) || loaders[0];
  if (!pick) throw new Error(`Fabric Loader ${pinnedLoader} introuvable.`);
  const loaderVersion = pick.loader.version;

  const profile = await fetchJson(`${META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`);
  const vdir = path.join(paths.versions, profile.id);
  await fsp.mkdir(vdir, { recursive: true });
  await fsp.writeFile(path.join(vdir, `${profile.id}.json`), JSON.stringify(profile, null, 2));

  const libs = profile.libraries.map((l) => {
    const p = mavenPath(l.name);
    const base = (l.url || 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
    return { name: l.name, path: p, url: base + p, sha1: l.sha1 || null };
  });

  let done = 0;
  await mapLimit(libs, 8, async (l) => {
    if (!l.sha1) {
      try { l.sha1 = (await fetchText(l.url + '.sha1')).trim().split(/\s+/)[0]; } catch (_) { l.sha1 = null; }
    }
    if (!l.sha1) log(`⚠ Pas de SHA-1 publié pour ${l.name} : fichier non vérifié.`, 'warn');
    await download(l.url, path.join(paths.libraries, l.path), { algo: 'sha1', hash: l.sha1, force: !l.sha1 });
    done++;
    progress({ step: 'fabric', pct: Math.round((done / libs.length) * 100), text: `Fabric ${done}/${libs.length}` });
  });

  log(`Fabric Loader ${loaderVersion} installé.`);
  return {
    id: profile.id,
    loaderVersion,
    mainClass: profile.mainClass,
    arguments: profile.arguments || {},
    libraries: libs.map((l) => ({ name: l.name, path: l.path }))
  };
}

module.exports = { installFabric };
