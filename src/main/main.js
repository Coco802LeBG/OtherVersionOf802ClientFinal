'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { makePaths } = require('./paths');
const { JsonStore, DEFAULT_SETTINGS, defaultProfile } = require('./store');
const util = require('./util');
const auth = require('./auth');
const accountsMod = require('./accounts');
const launch = require('./launch');
const modrinth = require('./modrinth');
const client802 = require('./client802');
const java = require('./java');

let win = null;
let ctx = null;
const logBuffer = [];
let logStream = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 720, minWidth: 940, minHeight: 620,
    backgroundColor: '#07080f',
    title: '802 Client',
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#07080f', symbolColor: '#8d93b3', height: 36 } } : {}),
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { tb: process.platform === 'win32' ? '1' : '0' } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function setupLogging(paths) {
  fs.mkdirSync(paths.logs, { recursive: true });
  logStream = fs.createWriteStream(path.join(paths.logs, 'latest.log'), { flags: 'w' });
  util.setLogSink((line, level) => {
    const stamp = new Date().toLocaleTimeString();
    const entry = { t: stamp, level, line };
    logBuffer.push(entry);
    if (logBuffer.length > 4000) logBuffer.shift();
    logStream.write(`[${stamp}] [${level}] ${line}\n`);
    send('log', entry);
  });
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) {
      util.log(`Erreur (${channel}) : ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  });
}

function getProfile(id) {
  const p = ctx.profiles.data.find((x) => x.id === id);
  if (!p) throw new Error('Profil introuvable.');
  return p;
}
function cleanProfile(p, old) {
  const num = (v, d, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const ramMax = num(p.ramMax, 4096, 512, 65536);
  return {
    ...(old || defaultProfile()),
    id: old ? old.id : p.id,
    name: String(p.name || 'Profil').slice(0, 40),
    ramMax,
    ramMin: Math.min(ramMax, num(p.ramMin, 1024, 256, 65536)),
    jvmArgs: String(p.jvmArgs || ''),
    javaPath: String(p.javaPath || ''),
    width: num(p.width, 1280, 320, 7680),
    height: num(p.height, 720, 240, 4320),
    fullscreen: !!p.fullscreen,
    gameDir: String(p.gameDir || ''),
    install802: !!p.install802
  };
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(), dataDir: ctx.paths.root, platform: process.platform,
    mcVersion: config.MC_VERSION, canEncrypt: ctx.accounts.canEncrypt(),
    defaultClientId: !!config.AZURE_CLIENT_ID, packaged: app.isPackaged, totalMemMB: Math.round(require('os').totalmem() / 1048576), friendsWhitelist: config.FRIENDS_WHITELIST
  }));

  handle('settings:get', () => ctx.settings.data);
  handle('settings:set', (patch) => {
    const allowed = ['language', 'azureClientId', 'devMode', 'offlineName', 'autoUpdateClient', 'minimizeOnLaunch', 'activeProfile', 'activeAccount', 'showMicrosoftLogin'];
    for (const k of allowed) if (k in patch) ctx.settings.data[k] = patch[k];
    ctx.settings.save();
    return ctx.settings.data;
  });

  handle('profiles:list', () => ctx.profiles.data);
  handle('profiles:save', (p) => {
    const i = ctx.profiles.data.findIndex((x) => x.id === p.id);
    if (i >= 0) ctx.profiles.data[i] = cleanProfile(p, ctx.profiles.data[i]);
    else {
      let id = util.slug(p.name || 'profil'); let n = 1;
      while (ctx.profiles.data.some((x) => x.id === id)) id = `${util.slug(p.name)}-${++n}`;
      ctx.profiles.data.push(cleanProfile({ ...p, id }, null));
      ctx.profiles.data[ctx.profiles.data.length - 1].id = id;
    }
    ctx.profiles.save();
    return ctx.profiles.data;
  });
  handle('profiles:duplicate', (id) => {
    const src = getProfile(id);
    let nid = `${src.id}-copie`; let n = 1;
    while (ctx.profiles.data.some((x) => x.id === nid)) nid = `${src.id}-copie${++n}`;
    ctx.profiles.data.push({ ...JSON.parse(JSON.stringify(src)), id: nid, name: `${src.name} (copie)`, gameDir: '', client: null, mods: [] });
    ctx.profiles.save();
    return ctx.profiles.data;
  });
  handle('profiles:delete', (id) => {
    if (ctx.profiles.data.length <= 1) throw new Error('Garde au moins un profil.');
    ctx.profiles.data = ctx.profiles.data.filter((x) => x.id !== id);
    if (ctx.settings.data.activeProfile === id) { ctx.settings.data.activeProfile = ctx.profiles.data[0].id; ctx.settings.save(); }
    ctx.profiles.save();
    return ctx.profiles.data;
  });

  // Comptes
  handle('accounts:list', () => ctx.accounts.list());
  let loginAbort = null;
 
handle('accounts:login', async () => {
  if (loginAbort) {
    throw new Error('Une connexion est déjà en cours.');
  }

  const clientId =
    ctx.settings.data.azureClientId ||
    config.AZURE_CLIENT_ID;

  if (!clientId) {
    throw new Error('Client ID Microsoft manquant.');
  }

  const controller = new AbortController();
  loginAbort = controller;

  try {
    const acc = await auth.login(
      clientId,
      (info) => {
        send('auth-code', info);

        if (info.url && info.url.startsWith('https://')) {
          shell.openExternal(info.url).catch(() => {});
        }
      },
      controller.signal
    );

    if (
      !acc ||
      acc.type !== 'msa' ||
      !acc.uuid ||
      !acc.name ||
      !acc.refreshToken ||
      !acc.mcToken
    ) {
      throw new Error('Le profil Minecraft reçu est invalide.');
    }

    // Enregistre le compte via le système sécurisé existant.
    const saved = ctx.accounts.persist(acc);

    // Sélectionne automatiquement ce compte au prochain lancement.
    ctx.settings.data.activeAccount = acc.uuid;
    ctx.settings.save();

    util.log(`Compte enregistré : ${acc.name} (${acc.uuid}).`);

    return {
      name: acc.name,
      uuid: acc.uuid,
      saved
    };
  } finally {
    if (loginAbort === controller) {
      loginAbort = null;
    }
  }
});

  handle('accounts:cancelLogin', () => { if (loginAbort) loginAbort.abort(); });
  handle('accounts:logout', (uuid) => {
    ctx.accounts.remove(uuid);
    if (ctx.settings.data.activeAccount === uuid) { ctx.settings.data.activeAccount = null; ctx.settings.save(); }
    return true;
  });

  // Java
  handle('java:detect', () => java.detectJavas());
  handle('java:download', () => java.downloadTemurin(ctx.paths, 21, (p) => send('progress', p)));

  // Lancement
  handle('launch:start', async (profileId) => {
    const profile = getProfile(profileId);
    try {
      await launch.start(ctx, profile, (ch, payload) => {
        send(ch, payload);
        if (ch === 'game-state' && win) {
          if (payload.state === 'running' && ctx.settings.data.minimizeOnLaunch) win.minimize();
          if (payload.state === 'stopped') { win.restore(); win.focus(); }
        }
      });
    } catch (e) {
      send('game-state', { state: 'stopped', code: -1 });
      throw e;
    }
    return true;
  });
  handle('launch:stop', () => launch.stop());

  // Mods
  handle('mods:search', (q) => {
    const p = getProfile(q.profileId);
    return modrinth.search({ query: q.query, category: q.category, offset: q.offset || 0, mcVersion: p.mcVersion });
  });
  handle('mods:install', async (profileId, projectId) => {
    const p = getProfile(profileId);
    const modsDir = path.join(launch.gameDirOf(ctx.paths, p), 'mods');
    const rec = await modrinth.installProject(modsDir, p, projectId, {});
    // un mod choisi par l'utilisateur n'est plus une simple dépendance
    const m = p.mods.find((x) => x.projectId === projectId);
    if (m) m.dependency = false;
    ctx.profiles.save();
    return rec;
  });
  handle('mods:remove', async (profileId, projectId) => {
    const p = getProfile(profileId);
    await modrinth.removeMod(path.join(launch.gameDirOf(ctx.paths, p), 'mods'), p, projectId);
    ctx.profiles.save();
    return true;
  });
  handle('mods:list', (profileId) => {
    const p = getProfile(profileId);
    const dir = path.join(launch.gameDirOf(ctx.paths, p), 'mods');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jar')); } catch (_) {}
    const known = new Set(p.mods.map((m) => m.filename));
    if (p.client) known.add(p.client.filename);
    return {
      managed: [
        ...(p.client ? [{ title: '802 Client', versionNumber: p.client.tag, filename: p.client.filename, system: true, source: 'github.com/' + config.CLIENT_REPO, license: 'MIT', sha: p.client.sha256, projectId: '802-client' }] : []),
        ...p.mods.map((m) => ({ ...m, sha: m.sha512, source: 'modrinth.com/mod/' + m.slug }))
      ],
      manual: files.filter((f) => !known.has(f))
    };
  });

  // Client 802
  handle('client:check', (profileId) => client802.check(getProfile(profileId)));
  handle('client:update', async (profileId) => {
    const p = getProfile(profileId);
    const r = await client802.install(path.join(launch.gameDirOf(ctx.paths, p), 'mods'), p);
    ctx.profiles.save();
    return r;
  });

  // Divers
  handle('shell:open', (url) => { if (typeof url === 'string' && url.startsWith('https://')) return shell.openExternal(url); });
  handle('shell:folder', (what) => {
    let dir = ctx.paths.root;
    if (what === 'logs') dir = ctx.paths.logs;
    else if (what && what.startsWith('profile:')) dir = launch.gameDirOf(ctx.paths, getProfile(what.slice(8)));
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('logs:get', () => logBuffer);

  // Mise à jour du launcher
  handle('updater:check', async () => {
    if (!app.isPackaged) return { status: 'dev' };
    const { autoUpdater } = require('electron-updater');
    const r = await autoUpdater.checkForUpdates();
    return { status: 'checked', version: r && r.updateInfo && r.updateInfo.version };
  });
  handle('updater:install', () => { const { autoUpdater } = require('electron-updater'); autoUpdater.quitAndInstall(); });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => util.log('[maj] ' + m), warn: (m) => util.log('[maj] ' + m, 'warn'), error: (m) => util.log('[maj] ' + m, 'warn'), debug() {} };
  autoUpdater.on('checking-for-update', () => send('updater-status', { status: 'checking' }));
  autoUpdater.on('update-available', (i) => send('updater-status', { status: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send('updater-status', { status: 'none' }));
  autoUpdater.on('download-progress', (p) => send('updater-status', { status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send('updater-status', { status: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => send('updater-status', { status: 'error', message: String(e && e.message || e) }));
  autoUpdater.checkForUpdates().catch(() => {});
}

// ---------- Démarrage ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const paths = makePaths(path.join(app.getPath('appData'), '802-client'));
    fs.mkdirSync(paths.root, { recursive: true });
    setupLogging(paths);
    const settings = new JsonStore(paths.settings, DEFAULT_SETTINGS);
    const profiles = new JsonStore(paths.profiles, [defaultProfile()]);
    if (!profiles.data.length) profiles.data = [defaultProfile()];
    if (!profiles.data.some((p) => p.id === settings.data.activeProfile)) settings.data.activeProfile = profiles.data[0].id;
    ctx = {
      paths, settings, profiles,
      accounts: accountsMod.create(paths.accounts, safeStorage),
      saveProfiles: () => profiles.save(),
      launcherVersion: app.getVersion()
    };
    util.log(`802 Client Launcher ${app.getVersion()} — données dans ${paths.root}`);
    registerIpc();
    createWindow();
    setupAutoUpdater();
  });
  app.on('window-all-closed', () => { launch.stop(); app.quit(); });
}
