
'use strict';

// Orchestration : installer Minecraft, Fabric, les mods et Java,
// puis lancer le jeu avec le compte sélectionné.

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
  return profile.gameDir
    ? profile.gameDir
    : path.join(paths.instances, profile.id);
}

async function getAccount(ctx) {
  const s = ctx.settings.data;

  // Compte hors ligne réservé au mode de développement autorisé.
  if (s.devMode && s.activeAccount === 'offline') {
    const name = (s.offlineName || '').trim();

    const allowed = config.FRIENDS_WHITELIST.some(
      (friend) => friend.toLowerCase() === name.toLowerCase()
    );

    if (!allowed) {
      throw new Error(
        `« ${name || '(vide)'} » n'est pas dans la liste des amis autorisés.`
      );
    }

    log(
      "⚠ Compte de test hors ligne : les serveurs officiels peuvent refuser la connexion.",
      'warn'
    );

    return auth.offlineAccount(name);
  }

  // Charger le compte sélectionné.
  let acc = s.activeAccount
    ? ctx.accounts.load(s.activeAccount)
    : null;

  if (!acc) {
    throw new Error(
      'Aucun compte connecté. Va dans Réglages > Compte et connecte ton compte Microsoft.'
    );
  }

  // Un compte hors ligne ne doit jamais passer par le renouvellement Microsoft.
  if (acc.type !== 'msa') {
    throw new Error(
      'Ce compte n’est pas un compte Microsoft valide. Reconnecte ton compte.'
    );
  }

  if (!acc.refreshToken || !acc.uuid || !acc.name) {
    throw new Error(
      'La session Microsoft est incomplète. Reconnecte ton compte.'
    );
  }

  // Renouveler uniquement si le jeton Minecraft est absent ou expiré.
  if (!acc.mcToken || !acc.mcExpires || acc.mcExpires <= Date.now()) {
    log('Renouvellement de la session Minecraft…');

    acc = await auth.refresh(
      s.azureClientId || config.AZURE_CLIENT_ID,
      acc
    );

    if (
      !acc ||
      acc.type !== 'msa' ||
      !acc.uuid ||
      !acc.name ||
      !acc.mcToken
    ) {
      throw new Error(
        'Le renouvellement n’a pas retourné de session Minecraft valide. Reconnecte ton compte.'
      );
    }

    // Conserver le compte avec le système de stockage existant.
    ctx.accounts.persist(acc);
  }

  addSecret(acc.mcToken);
  return acc;
}

let child = null;

function isRunning() {
  return !!child;
}

function stop() {
  if (child) {
    child.kill();
  }
}

async function start(ctx, profile, emit) {
  if (child) {
    throw new Error('Le jeu est déjà lancé.');
  }

  const { paths } = ctx;
  const progress = (p) => emit('progress', p);
  const mc = profile.mcVersion || config.MC_VERSION;
  const gameDir = gameDirOf(paths, profile);
  const modsDir = path.join(gameDir, 'mods');

  fs.mkdirSync(modsDir, { recursive: true });

  emit('game-state', { state: 'preparing' });

  const account = await getAccount(ctx);

  log(
    `Compte : ${account.name} (${account.type === 'msa' ? 'Microsoft' : 'hors-ligne'})`
  );

  const { versionJson, logArg } = await installVanilla(
    paths,
    mc,
    progress
  );

  const fabric = await installFabric(paths, mc, progress);

  progress({
    step: 'mods',
    pct: 0,
    text: 'Fabric API…'
  });

  await modrinth.ensureFabricApi(modsDir, profile);

  if (profile.install802) {
    progress({
      step: 'mods',
      pct: 50,
      text: '802 Client…'
    });

    if (ctx.settings.data.autoUpdateClient || !profile.client) {
      await client802.install(modsDir, profile);
    }
  }

  ctx.saveProfiles();

  progress({
    step: 'mods',
    pct: 100,
    text: 'Mods prêts.'
  });

  const javaPath = await resolveJava(
    paths,
    profile,
    versionJson.javaVersion,
    progress
  );

  const cmd = buildCommand({
    vanilla: versionJson,
    logArg,
    fabric,
    paths,
    profile,
    account,
    javaPath,
    gameDir,
    mcVersion: mc,
    launcherVersion: ctx.launcherVersion
  });

  log(
    'Commande : ' +
      [cmd.command, ...cmd.args]
        .map((arg) => (
          arg.length > 160 ? arg.slice(0, 80) + '…' : arg
        ))
        .join(' ')
  );

  emit('game-state', { state: 'running' });

  progress({
    step: 'play',
    pct: 100,
    text: 'Minecraft démarre…'
  });

  child = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    windowsHide: true
  });

  const pipeLines = (stream, level) => {
    if (!stream) return;

    let buf = '';

    stream.on('data', (data) => {
      buf += data.toString('utf8');

      let i;

      while ((i = buf.indexOf('\n')) >= 0) {
        log(
          '[jeu] ' + buf.slice(0, i).replace(/\r$/, ''),
          level
        );

        buf = buf.slice(i + 1);
      }
    });
  };

  pipeLines(child.stdout, 'game');
  pipeLines(child.stderr, 'game');

  child.on('error', (error) => {
    log(
      'Impossible de lancer Java : ' + error.message,
      'error'
    );

    child = null;

    emit('game-state', {
      state: 'stopped',
      error: error.message
    });
  });

  child.on('exit', (code) => {
    log(
      `Minecraft s'est arrêté (code ${code}).`,
      code === 0 ? 'info' : 'warn'
    );

    child = null;

    emit('game-state', {
      state: 'stopped',
      code
    });
  });
}

module.exports = {
  start,
  stop,
  isRunning,
  gameDirOf
};
