'use strict';
const bridge = window.api;
if (new URLSearchParams(location.search).get('tb') === '1') document.body.classList.add('has-titlebar');

const S = {
  page: 'play', info: null, settings: null, profiles: [], accounts: [],
  game: 'idle', progress: { step: '', pct: 0, text: '' }, logs: [],
  clientStatus: null, updater: { status: 'idle' },
  mods: { tab: 'browse', query: '', category: '', hits: [], total: 0, offset: 0, installed: { managed: [], manual: [] }, busy: new Set(), loading: false },
  editId: null
};

// ---------- Petits outils ----------
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function toast(msg, kind = '') {
  const n = el('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(n);
  setTimeout(() => n.remove(), kind === 'err' ? 9000 : 4000);
}
async function call(channel, ...args) {
  try { return await bridge.invoke(channel, ...args); }
  catch (e) { toast(e.message, 'err'); throw e; }
}
const $view = () => document.getElementById('view');
const mount = (...nodes) => $view().replaceChildren(...nodes.filter(Boolean));
const profile = () => S.profiles.find((p) => p.id === S.settings.activeProfile) || S.profiles[0];
const account = () => S.accounts.find((a) => a.uuid === S.settings.activeAccount);
const fmtNum = (n) => new Intl.NumberFormat().format(n);

// ---------- Barre latérale ----------
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  mods: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  profiles: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  logs: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>'
};
function icon(name) { const n = el('span', { class: 'ico' }); n.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; return n; }
function renderSidebar() {
  const nav = (id, label) => el('button', { class: 'nav' + (S.page === id ? ' active' : ''), onclick: () => go(id) }, icon(id), label);
  const acc = account();
  const devOffline = S.settings.devMode && S.settings.activeAccount === 'offline';
  const side = document.getElementById('sidebar');
  side.replaceChildren(
    el('div', { class: 'brand' }, el('div', { class: 'brand-mark' }, '802'), el('div', { class: 'brand-name' }, '802 Client')),
    nav('play', t('nav_play')), nav('mods', t('nav_mods')), nav('profiles', t('nav_profiles')),
    nav('settings', t('nav_settings')), nav('logs', t('nav_logs')),
    el('div', { class: 'spacer' }),
    el('div', { class: 'side-foot' },
      el('div', { class: 'account-chip' }, el('span', { class: 'dot ' + (acc || devOffline ? 'ok' : 'warn') }),
        acc ? acc.name : devOffline ? S.settings.offlineName + ' (test)' : t('no_account')),
      el('div', {}, 'v' + S.info.version)
    )
  );
}
function go(page) {
  S.page = page; render();
  if (page === 'mods') loadInstalled().then(() => { if (!S.mods.hits.length) runSearch(false); else render(); }).catch(() => {});
}

// ---------- Page Jouer ----------
function renderPlay() {
  const p = profile();
  const busy = S.game === 'preparing';
  const running = S.game === 'running';

  const playBtn = el('button', {
    class: 'play' + (running ? ' stop' : ''), disabled: busy,
    onclick: running ? () => call('launch:stop') : startGame
  }, busy ? t('preparing') : running ? t('stop') : t('play'));

  const pr = S.progress;
  const bar = el('div', { class: 'progress' }, el('i', { style: `width:${Math.max(0, Math.min(100, pr.pct || 0))}%` }));
  const stepLabel = pr.step ? t('step_' + pr.step) + ' : ' : '';
  const ptext = el('div', { class: 'progress-text' }, busy || running ? stepLabel + (pr.text || '') : '');

  let clientBox;
  const cs = S.clientStatus;
  if (!p.install802) clientBox = el('div', { class: 'muted small' }, '—');
  else if (!p.client) clientBox = el('div', { class: 'muted small' }, t('client_not_installed'));
  else if (cs && cs.updateAvailable) {
    clientBox = el('div', { class: 'notice' }, t('client_update') + ' ' + cs.latest + ' ',
      el('button', { class: 'btn small primary', onclick: updateClient }, t('client_update_btn')));
  } else clientBox = el('div', { class: 'row' }, el('span', { class: 'badge ok' }, p.client.tag), el('span', { class: 'muted small' }, t('client_ok')));

  const profSel = el('select', { onchange: async (e) => { S.settings = await call('settings:set', { activeProfile: e.target.value }); S.clientStatus = null; render(); checkClient(); } },
    S.profiles.map((x) => el('option', { value: x.id, selected: x.id === p.id }, x.name)));

  const acc = account();
  const devOffline = S.settings.devMode && S.settings.activeAccount === 'offline';
  const who = acc ? acc.name : devOffline ? S.settings.offlineName + ' (test)' : null;

  mount(
    el('div', { class: 'stage' },
      el('h1', { class: 'hero-title' }, '802 Client'),
      el('p', { class: 'hero-sub' }, t('hero_sub')),
      el('div', { class: 'play-row' }, playBtn,
        el('div', { class: 'play-meta' }, el('span', {}, 'Minecraft ', el('b', {}, p.mcVersion)), el('span', {}, who ? el('b', {}, who) : t('no_account')))),
      bar, ptext),
    el('div', { class: 'tiles' },
      el('div', { class: 'card tile' }, el('div', { class: 'k' }, t('profile')), profSel,
        el('div', { class: 'small muted' }, `${p.ramMax} Mo · ${p.fullscreen ? t('p_fullscreen') : p.width + '×' + p.height}`)),
      el('div', { class: 'card tile' }, el('div', { class: 'k' }, t('client_version')), clientBox),
      el('div', { class: 'card tile' }, el('div', { class: 'k' }, t('account')),
        el('div', { class: 'v' }, who || '—'),
        who ? null : el('button', { class: 'btn small primary', onclick: () => go('settings') }, t('login_ms')))),
    el('div', { class: 'notice warn', style: 'margin-top:14px' }, el('strong', {}, t('rules_title')), el('div', { class: 'small' }, t('rules_text'))),
    S.updater.status === 'ready' ? el('div', { class: 'notice', style: 'margin-top:14px' }, t('upd_ready') + ' ',
      el('button', { class: 'btn small primary', onclick: () => call('updater:install') }, t('upd_restart'))) : null
  );
}
async function startGame() {
  const devOffline = S.settings.devMode && S.settings.activeAccount === 'offline';
  if (!account() && !devOffline) { toast(t('need_account'), 'err'); go('settings'); return; }
  S.game = 'preparing'; S.progress = { step: '', pct: 0, text: '' };
  go('play');
  try { await call('launch:start', profile().id); }
  catch (_) { S.game = 'idle'; render(); }
}
async function checkClient() {
  const p = profile();
  if (!p || !p.install802) return;
  try { S.clientStatus = await bridge.invoke('client:check', p.id); if (S.page === 'play') render(); } catch (_) { /* silencieux */ }
}
async function updateClient() {
  try { toast(t('installing')); await call('client:update', profile().id); S.profiles = await call('profiles:list'); S.clientStatus = null; await checkClient(); toast('OK', 'ok'); render(); } catch (_) {}
}

// ---------- Page Mods ----------
const CATEGORIES = ['', 'optimization', 'utility', 'decoration', 'library', 'game-mechanics', 'equipment', 'social', 'management', 'technology', 'worldgen', 'storage'];
async function loadInstalled() { S.mods.installed = await call('mods:list', profile().id); }
async function runSearch(append) {
  const m = S.mods;
  if (!append) { m.offset = 0; m.hits = []; }
  m.loading = true; render();
  try {
    const r = await call('mods:search', { profileId: profile().id, query: m.query, category: m.category, offset: m.offset });
    m.hits = m.hits.concat(r.hits); m.total = r.total; m.offset = m.hits.length;
  } catch (_) {}
  m.loading = false; render();
}
function modCard(hit, isInstalled) {
  const busy = S.mods.busy.has(hit.projectId);
  const restricted = /all.?rights|arr\b/i.test(hit.license);
  const icon = hit.icon ? el('img', { src: hit.icon, alt: '' }) : el('div', { class: 'ph' });
  const btn = isInstalled
    ? el('button', { class: 'btn small danger', disabled: busy, onclick: () => removeMod(hit.projectId) }, t('remove'))
    : el('button', { class: 'btn small primary', disabled: busy, onclick: () => installMod(hit.projectId) }, busy ? t('installing') : t('install'));
  return el('div', { class: 'mod' }, icon,
    el('div', {},
      el('div', { class: 'title' }, hit.title, ' ', el('span', { class: 'muted small' }, hit.author ? 'par ' + hit.author : '')),
      el('div', { class: 'desc' }, hit.description),
      el('div', { class: 'row', style: 'gap:6px;margin-top:4px' },
        el('span', { class: 'badge' }, fmtNum(hit.downloads) + ' ↓'),
        hit.license ? el('span', { class: 'badge' + (restricted ? ' warn' : '') }, restricted ? t('restricted') : hit.license) : null)),
    btn);
}
async function installMod(id) {
  S.mods.busy.add(id); render();
  try { await call('mods:install', profile().id, id); await loadInstalled(); S.profiles = await call('profiles:list'); toast('✔ ' + t('install'), 'ok'); } catch (_) {}
  S.mods.busy.delete(id); render();
}
async function removeMod(id) {
  S.mods.busy.add(id); render();
  try { await call('mods:remove', profile().id, id); await loadInstalled(); S.profiles = await call('profiles:list'); } catch (_) {}
  S.mods.busy.delete(id); render();
}
function renderMods() {
  const m = S.mods;
  const instIds = new Set(m.installed.managed.map((x) => x.projectId));
  let timer;
  const search = el('input', { type: 'search', placeholder: t('search'), value: m.query,
    oninput: (e) => { m.query = e.target.value; clearTimeout(timer); timer = setTimeout(() => runSearch(false), 450); } });

  const tabs = el('div', { class: 'tabs' },
    el('button', { class: 'tab' + (m.tab === 'browse' ? ' active' : ''), onclick: () => { m.tab = 'browse'; render(); } }, t('browse')),
    el('button', { class: 'tab' + (m.tab === 'installed' ? ' active' : ''), onclick: async () => { m.tab = 'installed'; await loadInstalled(); render(); } }, t('installed') + ` (${m.installed.managed.length})`));

  let body;
  if (m.tab === 'browse') {
    const chips = el('div', { class: 'chips' }, CATEGORIES.map((c) =>
      el('button', { class: 'chip' + (m.category === c ? ' active' : ''), onclick: () => { m.category = c; runSearch(false); } },
        t('cat_' + (c ? c.replace('-', '_') : 'all')))));
    body = el('div', {}, search, chips,
      el('div', { class: 'mods-list' }, m.hits.map((h) => modCard(h, instIds.has(h.projectId)))),
      !m.hits.length && !m.loading ? el('p', { class: 'muted' }, t('no_results')) : null,
      m.hits.length < m.total ? el('p', {}, el('button', { class: 'btn', disabled: m.loading, onclick: () => runSearch(true) }, t('more'))) : null);
  } else {
    body = el('div', { class: 'mods-list' },
      m.installed.managed.map((x) => el('div', { class: 'mod' }, el('div', { class: 'ph' }),
        el('div', {},
          el('div', { class: 'title' }, x.title, ' ', el('span', { class: 'muted small' }, x.versionNumber || ''),
            x.system ? el('span', { class: 'badge', style: 'margin-left:6px' }, t('system')) : null,
            x.dependency && !x.system ? el('span', { class: 'badge', style: 'margin-left:6px' }, 'dépendance') : null),
          el('div', { class: 'desc' }, x.filename),
          el('div', { class: 'small muted', style: 'word-break:break-all' }, `${x.source} · ${x.license || '?'} · ${String(x.sha || '').slice(0, 16)}…`)),
        x.system ? el('span') : el('button', { class: 'btn small danger', disabled: S.mods.busy.has(x.projectId), onclick: () => removeMod(x.projectId) }, t('remove')))),
      m.installed.manual.length ? el('div', { class: 'card' }, el('strong', {}, t('manual_mods')), el('div', { class: 'small muted' }, m.installed.manual.join(', '))) : null,
      el('div', {}, el('button', { class: 'btn small', onclick: () => call('shell:folder', 'profile:' + profile().id) }, t('open_folder'))));
  }
  mount(el('h1', {}, t('nav_mods')),
    el('p', { class: 'sub' }, `${profile().name} · Fabric ${profile().mcVersion}`),
    el('div', { class: 'notice warn small', style: 'margin-bottom:16px' }, t('mods_warn')), tabs, body);
  const s = $view().querySelector('input[type=search]');
  if (s && document.activeElement === document.body && m.tab === 'browse' && m.query) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ---------- Page Profils ----------
function renderProfiles() {
  if (!S.editId || !S.profiles.some((p) => p.id === S.editId)) S.editId = profile().id;
  const p = S.profiles.find((x) => x.id === S.editId);
  const maxRam = Math.max(4096, Math.floor((S.info.totalMemMB || 16384) * 0.85 / 256) * 256);

  const f = {
    name: el('input', { type: 'text', value: p.name }),
    ramMax: el('input', { type: 'range', min: 1024, max: maxRam, step: 256, value: p.ramMax }),
    ramMin: el('input', { type: 'number', min: 256, step: 256, value: p.ramMin }),
    jvm: el('textarea', {}, p.jvmArgs),
    java: el('input', { type: 'text', value: p.javaPath, placeholder: t('p_java_auto') }),
    w: el('input', { type: 'number', value: p.width }), h: el('input', { type: 'number', value: p.height }),
    full: el('input', { type: 'checkbox', checked: p.fullscreen }),
    dir: el('input', { type: 'text', value: p.gameDir, placeholder: S.info.dataDir + '/instances/' + p.id }),
    i802: el('input', { type: 'checkbox', checked: p.install802 })
  };
  const ramLabel = el('span', { class: 'muted' }, `${p.ramMax} Mo`);
  f.ramMax.addEventListener('input', () => { ramLabel.textContent = `${f.ramMax.value} Mo`; });
  const javaList = el('div', {});

  async function save() {
    const data = { id: p.id, name: f.name.value.trim() || 'Profil', ramMax: +f.ramMax.value, ramMin: +f.ramMin.value, jvmArgs: f.jvm.value,
      javaPath: f.java.value.trim(), width: +f.w.value, height: +f.h.value, fullscreen: f.full.checked, gameDir: f.dir.value.trim(), install802: f.i802.checked };
    S.profiles = await call('profiles:save', data); toast(t('saved'), 'ok'); render();
  }
  async function detect() {
    const list = await call('java:detect');
    javaList.replaceChildren(el('select', { onchange: (e) => { f.java.value = e.target.value; } },
      el('option', { value: '' }, t('p_java_auto')),
      list.map((j) => el('option', { value: j.path, selected: j.path === p.javaPath }, `${j.label} — ${j.path}`))));
  }
  async function dlJava() {
    toast('Java 21…'); const exe = await call('java:download'); f.java.value = exe; toast('Java 21 OK', 'ok');
  }

  mount(el('h1', {}, t('nav_profiles')), el('p', { class: 'sub' }, ''),
    el('div', { class: 'split' },
      el('div', { class: 'plist' },
        S.profiles.map((x) => el('button', { class: 'pitem' + (x.id === S.editId ? ' active' : ''), onclick: () => { S.editId = x.id; render(); } }, x.name)),
        el('button', { class: 'btn', onclick: async () => { S.profiles = await call('profiles:save', { name: 'Nouveau profil' }); S.editId = S.profiles[S.profiles.length - 1].id; render(); } }, t('new_profile'))),
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' },
          el('label', { class: 'field' }, t('p_name'), f.name),
          el('label', { class: 'field' }, el('span', {}, t('p_ram') + ' : ', ramLabel), f.ramMax),
          el('label', { class: 'field' }, t('p_ram_min') + ' (Mo)', f.ramMin),
          el('label', { class: 'field' }, t('p_jvm'), f.jvm)),
        el('div', { class: 'card stack' },
          el('label', { class: 'field' }, t('p_java'), f.java, el('span', { class: 'hint' }, t('p_java_hint'))),
          el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: detect }, t('p_detect')), el('button', { class: 'btn small', onclick: dlJava }, t('p_dl_java'))),
          javaList),
        el('div', { class: 'card stack' },
          el('div', { class: 'grid2' }, el('label', { class: 'field' }, t('p_res') + ' (largeur)', f.w), el('label', { class: 'field' }, '(hauteur)', f.h)),
          el('label', { class: 'check' }, f.full, t('p_fullscreen')),
          el('label', { class: 'field' }, t('p_gamedir'), f.dir, el('span', { class: 'hint' }, t('p_gamedir_hint'))),
          el('label', { class: 'check' }, f.i802, t('p_install802'))),
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', onclick: save }, t('save')),
          el('button', { class: 'btn', onclick: async () => { S.profiles = await call('profiles:duplicate', p.id); render(); } }, t('duplicate')),
          el('button', { class: 'btn', onclick: () => call('shell:folder', 'profile:' + p.id) }, t('open_folder')),
          el('button', { class: 'btn danger', onclick: async () => { if (confirm(p.name + ' ?')) { S.profiles = await call('profiles:delete', p.id); S.settings = await call('settings:get'); S.editId = null; render(); } } }, t('delete'))))));
}

// ---------- Page Réglages ----------
function renderSettings() {
  const s = S.settings;
  const set = async (patch) => { S.settings = await call('settings:set', patch); render(); };
  const lang = el('select', { onchange: (e) => { setLang(e.target.value); set({ language: e.target.value }); } },
    el('option', { value: 'fr', selected: s.language === 'fr' }, 'Français'), el('option', { value: 'en', selected: s.language === 'en' }, 'English'));
  const cid = el('input', { type: 'text', value: s.azureClientId, placeholder: S.info.defaultClientId ? '(valeur par défaut du launcher)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    onchange: (e) => set({ azureClientId: e.target.value.trim() }) });

  const accRows = S.accounts.map((a) => el('div', { class: 'row' },
    el('label', { class: 'check' }, el('input', { type: 'radio', name: 'acc', checked: s.activeAccount === a.uuid, onchange: () => set({ activeAccount: a.uuid }) }), a.name),
    el('button', { class: 'btn small danger', onclick: async () => { await call('accounts:logout', a.uuid); await refreshAccounts(); render(); } }, t('logout'))));
  if (s.devMode) accRows.push(el('label', { class: 'check' }, el('input', { type: 'radio', name: 'acc', checked: s.activeAccount === 'offline', onchange: () => set({ activeAccount: 'offline' }) }), t('s_friend_account') + ' : ' + (s.offlineName || '—')));

  const updText = { idle: '', dev: t('upd_dev'), checking: t('upd_checking'), none: t('upd_none'), available: t('upd_available') + ' ' + (S.updater.version || ''), downloading: t('upd_downloading') + ' ' + (S.updater.percent || 0) + '%', ready: t('upd_ready'), error: S.updater.message || '' }[S.updater.status] || '';

  mount(el('h1', {}, t('nav_settings')), el('p', { class: 'sub' }, ''),
    el('div', { class: 'stack', style: 'max-width:720px' },
      el('div', { class: 'card stack' }, el('h2', {}, t('s_account')),
        !S.info.canEncrypt ? el('div', { class: 'notice warn small' }, t('s_encrypt_warn')) : null,
        ...accRows,
        el('div', {}, el('button', { class: 'btn primary', onclick: login }, t('login_ms'))),
        (S.info.defaultClientId && !s.devMode) ? null : el('label', { class: 'field' }, t('s_clientid'), cid, el('span', { class: 'hint' }, t('s_clientid_hint')))),
      el('div', { class: 'card stack' },
        el('label', { class: 'field' }, t('s_language'), lang),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.autoUpdateClient, onchange: (e) => set({ autoUpdateClient: e.target.checked }) }), t('s_auto_client')),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.minimizeOnLaunch, onchange: (e) => set({ minimizeOnLaunch: e.target.checked }) }), t('s_minimize')),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.devMode, onchange: (e) => set({ devMode: e.target.checked }) }), el('span', {}, t('s_dev'), el('div', { class: 'small muted' }, t('s_dev_hint')))),
        s.devMode ? el('label', { class: 'field' }, t('s_offline_name'),
          el('select', { onchange: (e) => set({ offlineName: e.target.value }) },
            el('option', { value: '', disabled: true, selected: !s.offlineName }, t('s_friend_pick')),
            (S.info.friendsWhitelist || []).map((name) => el('option', { value: name, selected: name === s.offlineName }, name))),
          el('span', { class: 'hint' }, t('s_friend_hint'))) : null),
      el('div', { class: 'card stack' }, el('h2', {}, t('s_launcher') + ' v' + S.info.version),
        el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => call('updater:check') }, t('s_check_update')), el('span', { class: 'muted' }, updText),
          S.updater.status === 'ready' ? el('button', { class: 'btn small primary', onclick: () => call('updater:install') }, t('upd_restart')) : null),
        el('div', { class: 'small muted' }, t('s_data') + ' : ' + S.info.dataDir + ' '), el('div', {}, el('button', { class: 'btn small', onclick: () => call('shell:folder', 'root') }, t('open_folder')))),
      el('div', { class: 'card' }, el('h2', {}, t('s_credits')), el('div', { class: 'small muted' }, t('s_credits_text')))));
}
async function refreshAccounts() { S.accounts = await bridge.invoke('accounts:list'); }
function login() {
  let off;
  const body = el('div', { class: 'stack' }, el('h2', {}, t('login_title')), el('div', { class: 'muted' }, t('login_wait')));
  const bg = el('div', { class: 'modal-bg' }, el('div', { class: 'modal' }, body,
    el('button', { class: 'btn', onclick: () => { bridge.invoke('accounts:cancelLogin'); close(); } }, t('cancel'))));
  function close() { if (off) off(); bg.remove(); }
  document.getElementById('modal-root').append(bg);
  off = bridge.on('auth-code', (info) => {
    body.replaceChildren(el('h2', {}, t('login_title')), el('div', { class: 'muted' }, t('login_step')),
      el('div', { class: 'code' }, info.userCode), el('div', { class: 'small muted' }, info.url),
      el('button', { class: 'btn small', onclick: () => call('shell:open', info.url) }, t('open_page')), el('div', { class: 'muted small' }, t('login_wait')));
  });
  bridge.invoke('accounts:login').then(async (r) => {
    close(); await refreshAccounts(); S.settings = await bridge.invoke('settings:get');
    toast(r.name + ' ✔', 'ok'); if (!r.saved) toast(t('s_encrypt_warn'), 'err'); render();
  }).catch((e) => { close(); toast(e.message, 'err'); });
}

// ---------- Page Logs ----------
function logLine(e) { return el('div', { class: e.level }, `[${e.t}] ${e.line}`); }
function renderLogs() {
  const box = el('div', { class: 'logbox', id: 'logbox' }, S.logs.map(logLine));
  mount(el('h1', {}, t('nav_logs')), el('p', { class: 'sub' }, ''),
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('button', { class: 'btn', onclick: async () => { await navigator.clipboard.writeText(S.logs.map((e) => `[${e.t}] [${e.level}] ${e.line}`).join('\n')); toast(t('copied'), 'ok'); } }, t('logs_copy')),
      el('button', { class: 'btn', onclick: () => { S.logs = []; render(); } }, t('logs_clear')),
      el('button', { class: 'btn', onclick: () => call('shell:folder', 'logs') }, t('logs_open'))),
    box);
  box.scrollTop = box.scrollHeight;
}

// ---------- Rendu global ----------
function render() {
  renderSidebar();
  ({ play: renderPlay, mods: renderMods, profiles: renderProfiles, settings: renderSettings, logs: renderLogs }[S.page])();
}

// ---------- Événements du processus principal ----------
bridge.on('log', (e) => {
  S.logs.push(e); if (S.logs.length > 4000) S.logs.shift();
  const box = document.getElementById('logbox');
  if (box && S.page === 'logs') { const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30; box.append(logLine(e)); if (atEnd) box.scrollTop = box.scrollHeight; }
});
bridge.on('progress', (p) => { S.progress = p; if (S.page === 'play') render(); });
bridge.on('game-state', (g) => {
  S.game = g.state === 'preparing' ? 'preparing' : g.state === 'running' ? 'running' : 'idle';
  if (g.state === 'stopped') { toast(g.code === 0 || g.code === undefined ? t('game_stopped') : t('game_crash'), g.code === 0 ? '' : 'err'); S.progress = { step: '', pct: 0, text: '' }; checkClient(); }
  render();
});
bridge.on('updater-status', (u) => { S.updater = u; if (S.page === 'settings' || S.page === 'play') render(); });

// ---------- Démarrage ----------
(async function init() {
  try {
    S.info = await bridge.invoke('app:info');
    S.settings = await bridge.invoke('settings:get');
    S.profiles = await bridge.invoke('profiles:list');
    await refreshAccounts();
    S.logs = await bridge.invoke('logs:get');
    setLang(S.settings.language);
    render();
    checkClient();
  } catch (e) {
    document.body.textContent = 'Erreur au démarrage : ' + e.message;
  }
})();
