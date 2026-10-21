
'use strict';

// Connexion officielle : Microsoft -> Xbox Live -> XSTS -> Minecraft.
const crypto = require('crypto');
const { fetchJson, addSecret } = require('./util');

const MS_DEVICE =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';

const MS_TOKEN =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

const SCOPE = 'XboxLive.signin offline_access';

const XSTS_ERRORS = {
  2148916233:
    "Ce compte Microsoft n'a pas de profil Xbox. Vérifie sa configuration sur Xbox.",
  2148916235:
    "Xbox Live n'est pas disponible dans ce pays.",
  2148916236:
    "Une vérification d'âge est nécessaire sur Xbox.",
  2148916237:
    "Une vérification d'âge est nécessaire sur Xbox.",
  2148916238:
    "Ce compte nécessite une configuration familiale Microsoft."
};

function form(data) {
  return new URLSearchParams(data).toString();
}

async function postForm(url, data, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: form(data),
    signal
  });

  const json = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    json
  };
}

async function postJson(url, data, headers = {}, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers
    },
    body: JSON.stringify(data),
    signal
  });

  const json = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    json
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('Connexion annulée.'));
      return;
    }

    const timer = setTimeout(done, ms);

    function done() {
      if (signal) signal.removeEventListener('abort', abort);
      resolve();
    }

    function abort() {
      clearTimeout(timer);
      reject(new Error('Connexion annulée.'));
    }

    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

// Étape 1 : connexion Microsoft par code.
async function login(clientId, onCode, signal) {
  if (!clientId || typeof clientId !== 'string') {
    throw new Error(
      "Client ID Microsoft manquant. Configure-le dans Réglages > Compte Microsoft."
    );
  }

  const device = await postForm(
    MS_DEVICE,
    {
      client_id: clientId.trim(),
      scope: SCOPE
    },
    signal
  );

  if (!device.ok) {
    throw new Error(
      `Microsoft refuse la demande de connexion : ${
        device.json.error_description || device.status
      }`
    );
  }

  const d = device.json;

  if (!d.device_code || !d.user_code || !d.verification_uri) {
    throw new Error('Microsoft a retourné un code de connexion incomplet.');
  }

  onCode({
    userCode: d.user_code,
    url: d.verification_uri,
    expiresIn: d.expires_in
  });

  let interval = Math.max(5, Number(d.interval) || 5) * 1000;
  const deadline = Date.now() + Number(d.expires_in || 0) * 1000;

  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      throw new Error('Connexion annulée.');
    }

    await sleep(interval, signal);

    const token = await postForm(
      MS_TOKEN,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId.trim(),
        device_code: d.device_code
      },
      signal
    );

    if (token.ok) {
      return finishLogin(token.json, signal);
    }

    const error = token.json.error;

    if (error === 'authorization_pending') continue;

    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }

    if (error === 'authorization_declined') {
      throw new Error('La connexion Microsoft a été refusée.');
    }

    if (error === 'expired_token') {
      throw new Error('Le code Microsoft a expiré. Recommence.');
    }

    throw new Error(
      `Erreur Microsoft : ${
        token.json.error_description || error || token.status
      }`
    );
  }

  throw new Error('Le code Microsoft a expiré. Recommence.');
}

async function finishLogin(tokens, signal) {
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(
      'Microsoft n’a pas retourné les jetons nécessaires. Recommence la connexion.'
    );
  }

  const mc = await msToMinecraft(tokens.access_token, signal);

  addSecret(mc.mcToken);

  return {
    type: 'msa',
    uuid: mc.uuid,
    name: mc.name,
    refreshToken: tokens.refresh_token,
    mcToken: mc.mcToken,
    mcExpires: Date.now() + Math.max(60, mc.expiresIn - 120) * 1000
  };
}

// Étapes Xbox Live, XSTS et Minecraft.
async function msToMinecraft(msAccess, signal) {
  const xbox = await postJson(
    'https://user.auth.xboxlive.com/user/authenticate',
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: 'd=' + msAccess
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    },
    {},
    signal
  );

  if (!xbox.ok) {
    throw new Error(`Xbox Live refuse la connexion (${xbox.status}).`);
  }

  if (!xbox.json.Token) {
    throw new Error('Xbox Live n’a pas retourné de jeton.');
  }

  const xsts = await postJson(
    'https://xsts.auth.xboxlive.com/xsts/authorize',
    {
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xbox.json.Token]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    },
    {},
    signal
  );

  if (!xsts.ok) {
    const code = xsts.json.XErr;
    throw new Error(
      XSTS_ERRORS[code] ||
      `Xbox XSTS refuse la connexion (${xsts.status}, code ${code || '?'}).`
    );
  }

  const userHash = xsts.json.DisplayClaims?.xui?.[0]?.uhs;
  const xstsToken = xsts.json.Token;

  if (!userHash || !xstsToken) {
    throw new Error('La réponse Xbox XSTS est incomplète.');
  }

  const minecraft = await postJson(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    {
      identityToken: `XBL3.0 x=${userHash};${xstsToken}`
    },
    {},
    signal
  );

  if (!minecraft.ok) {
    const message = JSON.stringify(minecraft.json);

    if (message.includes('Invalid app registration')) {
      throw new Error(
        'Microsoft/Minecraft refuse l’enregistrement de cette application. ' +
        'Le Client ID doit être correctement enregistré et, si nécessaire, approuvé par Mojang. ' +
        'Consulte le README du projet.'
      );
    }

    throw new Error(
      `Minecraft refuse la connexion (${minecraft.status}) : ${message.slice(0, 250)}`
    );
  }

  const mcToken = minecraft.json.access_token;

  if (!mcToken) {
    throw new Error('Minecraft n’a pas retourné de jeton.');
  }

  let profile;

  try {
    profile = await fetchJson(
      'https://api.minecraftservices.com/minecraft/profile',
      {
        headers: {
          Authorization: `Bearer ${mcToken}`
        },
        signal
      }
    );
  } catch (error) {
    if (error.status === 404) {
      throw new Error(
        'Aucun profil Minecraft Java Edition utilisable n’a été trouvé pour ce compte.'
      );
    }

    if (error.status === 401 || error.status === 403) {
      throw new Error(
        `Minecraft n’a pas autorisé l’accès au profil (${error.status}). Reconnecte-toi et vérifie ton accès.`
      );
    }

    throw error;
  }

  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(profile.id) ||
    typeof profile.name !== 'string' ||
    !profile.name.trim()
  ) {
    throw new Error('Le profil Minecraft retourné est invalide.');
  }

  return {
    mcToken,
    expiresIn: Number(minecraft.json.expires_in) || 86400,
    uuid: profile.id,
    name: profile.name
  };
}

// Renouvellement de session Microsoft.
async function refresh(clientId, account) {
  if (!clientId || !account || !account.refreshToken) {
    throw new Error(
      'Session Microsoft incomplète. Déconnecte le compte et reconnecte-toi.'
    );
  }

  const token = await postForm(MS_TOKEN, {
    grant_type: 'refresh_token',
    client_id: clientId.trim(),
    refresh_token: account.refreshToken,
    scope: SCOPE
  });

  if (!token.ok || !token.json.access_token) {
    throw new Error(
      'La session Microsoft a expiré ou a été refusée. Reconnecte-toi dans Réglages.'
    );
  }

  const mc = await msToMinecraft(token.json.access_token);

  addSecret(mc.mcToken);

  return {
    ...account,
    type: 'msa',
    uuid: mc.uuid,
    name: mc.name,
    refreshToken: token.json.refresh_token || account.refreshToken,
    mcToken: mc.mcToken,
    mcExpires: Date.now() + Math.max(60, mc.expiresIn - 120) * 1000
  };
}

// Compte hors ligne réservé aux tests du launcher.
function offlineAccount(name) {
  const cleanName = String(name || '').trim();

  if (!/^[A-Za-z0-9_]{1,16}$/.test(cleanName)) {
    throw new Error('Le pseudo hors ligne doit contenir 1 à 16 lettres, chiffres ou _.');
  }

  const hash = crypto
    .createHash('md5')
    .update('OfflinePlayer:' + cleanName)
    .digest();

  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  return {
    type: 'offline',
    uuid: hash.toString('hex'),
    name: cleanName,
    mcToken: '0',
    mcExpires: Infinity
  };
}

module.exports = {
  login,
  refresh,
  offlineAccount
};
