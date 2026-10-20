'use strict';
// Stockage des comptes. Les tokens sont chiffrés avec safeStorage (DPAPI / Keychain / libsecret).
// Si le chiffrement n'est pas disponible, rien n'est écrit sur le disque.
const { JsonStore } = require('./store');
const { addSecret } = require('./util');

function create(file, safeStorage) {
  const store = new JsonStore(file, { accounts: [] });

  function canEncrypt() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend &&
          safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch (_) { return false; }
  }
  const enc = (s) => safeStorage.encryptString(s).toString('base64');
  const dec = (s) => safeStorage.decryptString(Buffer.from(s, 'base64'));

  const memory = new Map(); // comptes de la session (si chiffrement impossible)

  function persist(acc) {
    memory.set(acc.uuid, acc);
    addSecret(acc.mcToken);
    if (acc.type !== 'msa' || !canEncrypt()) return false;
    const rec = {
      type: 'msa', uuid: acc.uuid, name: acc.name,
      refresh: enc(acc.refreshToken), mc: enc(acc.mcToken), mcExpires: acc.mcExpires
    };
    const i = store.data.accounts.findIndex((a) => a.uuid === acc.uuid);
    if (i >= 0) store.data.accounts[i] = rec; else store.data.accounts.push(rec);
    store.save();
    return true;
  }

  function load(uuid) {
    if (memory.has(uuid)) return memory.get(uuid);
    const r = store.data.accounts.find((a) => a.uuid === uuid);
    if (!r || !canEncrypt()) return null;
    try {
      const acc = { type: 'msa', uuid: r.uuid, name: r.name, refreshToken: dec(r.refresh), mcToken: dec(r.mc), mcExpires: r.mcExpires };
      addSecret(acc.mcToken);
      memory.set(uuid, acc);
      return acc;
    } catch (_) { return null; }
  }

  function list() {
    const seen = new Map();
    for (const a of store.data.accounts) seen.set(a.uuid, { uuid: a.uuid, name: a.name, type: a.type });
    for (const a of memory.values()) if (a.type === 'msa') seen.set(a.uuid, { uuid: a.uuid, name: a.name, type: a.type });
    return [...seen.values()];
  }

  function remove(uuid) {
    memory.delete(uuid);
    store.data.accounts = store.data.accounts.filter((a) => a.uuid !== uuid);
    store.save();
  }

  return { persist, load, list, remove, canEncrypt };
}

module.exports = { create };
