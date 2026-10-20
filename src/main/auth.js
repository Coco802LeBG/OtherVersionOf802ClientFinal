'use strict';
// Connexion Microsoft -> Xbox Live -> XSTS -> Minecraft (flux officiel "device code").
// Aucun mot de passe n'est vu ni stocké. Les tokens sont chiffrés par le système (safeStorage).
const crypto = require('crypto');
const { fetchJson, addSecret, log } = require('./util');

const MS_DEVICE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';

const XSTS_ERRORS = {
  2148916233: "Ce compte Microsoft n'a pas de profil Xbox. Connecte-toi une fois sur xbox.com pour en créer un.",
  2148916235: "Xbox Live n'est pas disponible dans ton pays.",
  2148916236: 'Ce compte demande une vérification d\'âge sur Xbox.',
  2148916237: 'Ce compte demande une vérification d\'âge sur Xbox.',
  2148916238: 'Compte enfant : un adulte doit l\'ajouter à une famille Microsoft.'
};

function form(obj) {
  return new URLSearchParams(obj).toString();
}
async function postForm(url, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form(obj)
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Étape 1 : device code ----------
async function login(clientId, onCode, signal) {
  if (!clientId) throw new Error("Aucun Client ID Azure. Ajoute-le dans Réglages > Compte Microsoft (voir README).");
  const dc = await postForm(MS_DEVICE, { client_id: clientId, scope: SCOPE });
  if (!dc.ok) throw new Error(`Microsoft a refusé la demande de code : ${dc.json.error_description || dc.status}`);
  const d = dc.json;
  onCode({ userCode: d.user_code, url: d.verification_uri, expiresIn: d.expires_in });

  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + d.expires_in * 1000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Connexion annulée.');
    await sleep(interval);
    const t = await postForm(MS_TOKEN, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: d.device_code
    });
    if (t.ok) return finishLogin(t.json);
    const err = t.json.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'authorization_declined') throw new Error('Connexion refusée.');
    if (err === 'expired_token') throw new Error('Le code a expiré. Recommence.');
    throw new Error(`Erreur Microsoft : ${t.json.error_description || err}`);
  }
  throw new Error('Le code a expiré. Recommence.');
}

async function finishLogin(msTokens) {
  const mc = await msToMinecraft(msTokens.access_token);
  addSecret(mc.mcToken);
  return {
    type: 'msa',
    uuid: mc.uuid,
    name: mc.name,
    refreshToken: msTokens.refresh_token,
    mcToken: mc.mcToken,
    mcExpires: Date.now() + (mc.expiresIn - 120) * 1000
  };
}

// ---------- Étapes 2 à 5 : Xbox, XSTS, Minecraft ----------
async function msToMinecraft(msAccess) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccess },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
  if (!xbl.ok) throw new Error(`Xbox Live a refusé la connexion (${xbl.status}).`);

  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });
  if (!xsts.ok) {
    const msg = XSTS_ERRORS[xsts.json.XErr];
    throw new Error(msg || `XSTS a refusé la connexion (${xsts.status}, code ${xsts.json.XErr || '?'}).`);
  }
  const uhs = xsts.json.DisplayClaims.xui[0].uhs;

  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}`
  });
  if (!mc.ok) {
    const m = JSON.stringify(mc.json);
    if (m.includes('Invalid app registration')) {
      throw new Error(
        "Mojang refuse ton application Azure (\"Invalid app registration\"). Ton Client ID doit être approuvé : " +
        'remplis le formulaire https://aka.ms/mce-reviewappid (voir README, étape 2).'
      );
    }
    throw new Error(`Minecraft a refusé la connexion (${mc.status}) : ${m.slice(0, 200)}`);
  }
  const mcToken = mc.json.access_token;

  const prof = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcToken}` }
  }).catch((e) => {
    if (e.status === 404) throw new Error("Ce compte ne possède pas Minecraft Java Edition.");
    throw e;
  });
  return { mcToken, expiresIn: mc.json.expires_in || 86400, uuid: prof.id, name: prof.name };
}

// ---------- Renouvellement silencieux ----------
async function refresh(clientId, account) {
  const t = await postForm(MS_TOKEN, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: account.refreshToken,
    scope: SCOPE
  });
  if (!t.ok) throw new Error('Session expirée : reconnecte-toi (Réglages > Compte).');
  const mc = await msToMinecraft(t.json.access_token);
  addSecret(mc.mcToken);
  return {
    ...account,
    uuid: mc.uuid,
    name: mc.name,
    refreshToken: t.json.refresh_token || account.refreshToken,
    mcToken: mc.mcToken,
    mcExpires: Date.now() + (mc.expiresIn - 120) * 1000
  };
}

// Compte "test hors-ligne" (mode développeur uniquement)
function offlineAccount(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return { type: 'offline', uuid: h.toString('hex'), name, mcToken: '0', mcExpires: Infinity };
}

module.exports = { login, refresh, offlineAccount };
