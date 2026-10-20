'use strict';
// Orchestration : tout installer (Minecraft, Fabric, Fabric API, 802 Client, Java) puis lancer le jeu.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const auth = require('./auth');
const { log, addSecret } = require('./util');
const { installVanilla, buildCommand } = require('./minecraft');
const { installFabric } = require('./fabric');
const { resolveJava } = require('./java');
const modrinth = require('./modrinth');
const client802 = require('./client802');

function gameDirOf(paths, profile) {
  return profile.gameDir ? profile.gameDir : path.join(paths.instances, profile.id);
}

async function getAccount(ctx) {
  const s = ctx.settings.data;
  if (s.devMode && s.activeAccount === 'offline') {
    const name = (s.offlineName || '').trim();
    const allowed = config.FRIENDS_WHITELIST.some((f) => f.toLowerCase() === name.toLowerCase());
    if (!allowed) throw new Error(`« ${name || '(vide)'} » n'est pas dans la liste des amis autorisés. Demande à Coco802 de t'y ajouter.`);
    log('⚠ Compte de test (liste d\'amis) : impossible de rejoindre les serveurs officiels.', 'warn');
    return auth.offlineAccount(name);
  }
  let acc = s.activeAccount ? ctx.accounts.load(s.activeAccount) : null;
  if (!acc) throw new Error("Aucun compte connecté. Va dans Réglages > Compte et connecte ton compte Microsoft.");
  if (acc.mcExpires < Date.now()) {
    log('Renouvellement de la session Minecraft…');
    acc = await auth.refresh(s.azureClientId || config.AZURE_CLIENT_ID, acc);
    ctx.accounts.persist(acc);
  }
  addSecret(acc.mcToken);
  return acc;
}

let child = null;
function isRunning() { return !!child; }
function stop() { if (child) child.kill(); }

async function start(ctx, profile, emit) {
  if (child) throw new Error('Le jeu est déjà lancé.');
  const { paths } = ctx;
  const progress = (p) => emit('progress', p);
  const mc = profile.mcVersion || config.MC_VERSION;
  const gameDir = gameDirOf(paths, profile);
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  emit('game-state', { state: 'preparing' });
  const account = await getAccount(ctx);
  log(`Compte : ${account.name} (${account.type === 'msa' ? 'Microsoft' : 'hors-ligne'})`);

  const { versionJson, logArg } = await installVanilla(paths, mc, progress);
  const fabric = await installFabric(paths, mc, progress);

  progress({ step: 'mods', pct: 0, text: 'Fabric API…' });
  await modrinth.ensureFabricApi(modsDir, profile);
  if (profile.install802) {
    progress({ step: 'mods', pct: 50, text: '802 Client…' });
    if (ctx.settings.data.autoUpdateClient || !profile.client) await client802.install(modsDir, profile);
  }
  ctx.saveProfiles();
  progress({ step: 'mods', pct: 100, text: 'Mods prêts.' });

  const javaPath = await resolveJava(paths, profile, versionJson.javaVersion, progress);

  const cmd = buildCommand({
    vanilla: versionJson, logArg, fabric, paths, profile, account, javaPath, gameDir,
    mcVersion: mc, launcherVersion: ctx.launcherVersion
  });
  log('Commande : ' + [cmd.command, ...cmd.args].map((a) => (a.length > 160 ? a.slice(0, 80) + '…' : a)).join(' '));

  emit('game-state', { state: 'running' });
  progress({ step: 'play', pct: 100, text: 'Minecraft démarre…' });
  child = spawn(cmd.command, cmd.args, { cwd: cmd.cwd, windowsHide: true });
  const pipeLines = (stream, level) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { log('[jeu] ' + buf.slice(0, i).replace(/\r$/, ''), level); buf = buf.slice(i + 1); }
    });
  };
  pipeLines(child.stdout, 'game');
  pipeLines(child.stderr, 'game');
  child.on('error', (e) => { log('Impossible de lancer Java : ' + e.message, 'error'); });
  child.on('exit', (code) => {
    log(`Minecraft s'est arrêté (code ${code}).`, code === 0 ? 'info' : 'warn');
    child = null;
    emit('game-state', { state: 'stopped', code });
  });
}

module.exports = { start, stop, isRunning, gameDirOf };
