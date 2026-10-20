'use strict';
// Téléchargement de Minecraft depuis les serveurs OFFICIELS de Mojang (rien n'est redistribué).
// Tous les fichiers sont vérifiés en SHA-1.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { fetchJson, download, mapLimit, osName, log } = require('./util');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ASSET_BASE = 'https://resources.download.minecraft.net';

// ---------- Règles Mojang (rules / features) ----------
function osMatches(o) {
  if (!o) return true;
  if (o.name && o.name !== osName()) return false;
  if (o.arch) {
    const a = process.arch;
    const want = o.arch;
    const ok = (want === 'x86' && (a === 'ia32')) || (want === 'x64' && a === 'x64') ||
               (want === 'arm64' && a === 'arm64') || want === a;
    if (!ok) return false;
  }
  if (o.version) {
    try { if (!new RegExp(o.version).test(os.release())) return false; } catch (_) { return false; }
  }
  return true;
}
function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    let match = osMatches(r.os);
    if (match && r.features) {
      for (const [k, v] of Object.entries(r.features)) {
        if (!!features[k] !== !!v) { match = false; break; }
      }
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

// ---------- Installation de la version vanilla ----------
async function installVanilla(paths, mcVersion, progress) {
  progress({ step: 'minecraft', pct: 0, text: 'Lecture du manifest Mojang…' });
  const manifest = await fetchJson(MANIFEST_URL);
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`Version ${mcVersion} introuvable chez Mojang.`);

  const vdir = path.join(paths.versions, mcVersion);
  const vjsonPath = path.join(vdir, `${mcVersion}.json`);
  await download(entry.url, vjsonPath, { algo: 'sha1', hash: entry.sha1 });
  const vj = JSON.parse(await fsp.readFile(vjsonPath, 'utf8'));

  // client.jar
  const c = vj.downloads.client;
  progress({ step: 'minecraft', pct: 5, text: 'Téléchargement de minecraft.jar…' });
  await download(c.url, path.join(vdir, `${mcVersion}.jar`), { algo: 'sha1', hash: c.sha1 });

  // libraries
  const libs = collectLibraries(vj);
  let done = 0;
  await mapLimit(libs, 12, async (l) => {
    await download(l.url, path.join(paths.libraries, l.path), { algo: 'sha1', hash: l.sha1 });
    done++;
    if (done % 10 === 0 || done === libs.length) {
      progress({ step: 'minecraft', pct: 5 + Math.round((done / libs.length) * 25), text: `Bibliothèques ${done}/${libs.length}` });
    }
  });

  // assets
  const ai = vj.assetIndex;
  const indexPath = path.join(paths.assets, 'indexes', `${ai.id}.json`);
  await download(ai.url, indexPath, { algo: 'sha1', hash: ai.sha1 });
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  const objs = Object.entries(index.objects);
  let adone = 0;
  await mapLimit(objs, 24, async ([, o]) => {
    const sub = o.hash.slice(0, 2);
    await download(`${ASSET_BASE}/${sub}/${o.hash}`, path.join(paths.assets, 'objects', sub, o.hash), { algo: 'sha1', hash: o.hash });
    adone++;
    if (adone % 100 === 0 || adone === objs.length) {
      progress({ step: 'minecraft', pct: 30 + Math.round((adone / objs.length) * 55), text: `Ressources ${adone}/${objs.length}` });
    }
  });

  // config de log
  let logArg = null;
  if (vj.logging && vj.logging.client) {
    const lc = vj.logging.client;
    const lp = path.join(paths.assets, 'log_configs', lc.file.id);
    await download(lc.file.url, lp, { algo: 'sha1', hash: lc.file.sha1 });
    logArg = lc.argument.replace('${path}', lp);
  }

  progress({ step: 'minecraft', pct: 100, text: 'Minecraft prêt.' });
  return { versionJson: vj, logArg };
}

function collectLibraries(vj, features = {}) {
  const out = [];
  for (const lib of vj.libraries || []) {
    if (!rulesAllow(lib.rules, features)) continue;
    const art = lib.downloads && lib.downloads.artifact;
    if (!art) continue;
    out.push({ name: lib.name, path: art.path, url: art.url, sha1: art.sha1 });
  }
  return out;
}

// ---------- Arguments de lancement ----------
function flattenArgs(list, features) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') { out.push(a); continue; }
    if (!rulesAllow(a.rules, features)) continue;
    if (Array.isArray(a.value)) out.push(...a.value); else out.push(a.value);
  }
  return out;
}
function substitute(arg, vars) {
  return arg.replace(/\$\{([^}]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
function libKey(name) {
  const [g, a, , c] = name.split('@')[0].split(':');
  return `${g}:${a}:${c || ''}`;
}

// Fusionne vanilla + Fabric et construit la commande Java complète.
function buildCommand({ vanilla, logArg, fabric, paths, profile, account, javaPath, gameDir, mcVersion, launcherVersion }) {
  const features = {
    has_custom_resolution: !profile.fullscreen && !!profile.width && !!profile.height,
    is_demo_user: false, has_quick_plays_support: false,
    is_quick_play_singleplayer: false, is_quick_play_multiplayer: false, is_quick_play_realms: false
  };

  const libMap = new Map();
  for (const l of collectLibraries(vanilla, features)) libMap.set(libKey(l.name), path.join(paths.libraries, l.path));
  for (const l of fabric.libraries) libMap.set(libKey(l.name), path.join(paths.libraries, l.path));
  const clientJar = path.join(paths.versions, mcVersion, `${mcVersion}.jar`);
  const classpath = [...libMap.values(), clientJar].join(path.delimiter);

  const nativesDir = path.join(paths.versions, mcVersion, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });

  const vars = {
    auth_player_name: account.name,
    version_name: fabric.id,
    game_directory: gameDir,
    assets_root: paths.assets,
    assets_index_name: vanilla.assetIndex.id,
    auth_uuid: account.uuid,
    auth_access_token: account.mcToken,
    auth_session: account.mcToken,
    clientid: '',
    auth_xuid: '',
    user_type: account.type === 'msa' ? 'msa' : 'legacy',
    version_type: 'release',
    user_properties: '{}',
    resolution_width: profile.width,
    resolution_height: profile.height,
    natives_directory: nativesDir,
    launcher_name: '802-client-launcher',
    launcher_version: launcherVersion,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: paths.libraries
  };

  const jvmVersion = flattenArgs(vanilla.arguments && vanilla.arguments.jvm, features);
  const jvmFabric = flattenArgs(fabric.arguments && fabric.arguments.jvm, features);
  const gameVersion = flattenArgs(vanilla.arguments && vanilla.arguments.game, features);
  const gameFabric = flattenArgs(fabric.arguments && fabric.arguments.game, features);

  const jvm = [
    `-Xms${profile.ramMin}M`,
    `-Xmx${profile.ramMax}M`,
    ...require('./util').splitArgs(profile.jvmArgs),
    ...[...jvmVersion, ...jvmFabric].map((a) => substitute(a, vars))
  ];
  if (logArg) jvm.push(logArg);
  if (!jvm.some((a) => a === '-cp' || a === '-classpath')) jvm.push('-cp', classpath);

  const game = [...gameVersion, ...gameFabric].map((a) => substitute(a, vars));
  if (profile.fullscreen) game.push('--fullscreen');

  const args = [...jvm, fabric.mainClass, ...game];
  return { command: javaPath, args, cwd: gameDir };
}

module.exports = { installVanilla, buildCommand, rulesAllow, collectLibraries, flattenArgs, substitute };
