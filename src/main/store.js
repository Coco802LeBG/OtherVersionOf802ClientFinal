'use strict';
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = JSON.parse(JSON.stringify(defaults));
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = Array.isArray(defaults) ? raw : { ...this.data, ...raw };
    } catch (_) { /* premier lancement */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

const DEFAULT_SETTINGS = {
  language: 'fr',
  azureClientId: '',
  devMode: false,
  offlineName: 'Player',
  autoUpdateClient: true,
  minimizeOnLaunch: true,
  activeProfile: 'default',
  activeAccount: null
};

function defaultProfile() {
  return {
    id: 'default',
    name: '802 Client',
    mcVersion: '1.21.11',
    ramMax: 4096,
    ramMin: 1024,
    jvmArgs: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
    javaPath: '',
    width: 1280,
    height: 720,
    fullscreen: false,
    gameDir: '',
    install802: true,
    client: null,
    mods: []
  };
}

module.exports = { JsonStore, DEFAULT_SETTINGS, defaultProfile };
