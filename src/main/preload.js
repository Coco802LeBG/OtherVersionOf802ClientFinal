
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);

  if (!result || result.ok !== true) {
    throw new Error(
      result && result.error
        ? result.error
        : 'Erreur de communication avec le launcher.'
    );
  }

  return result.data;
}

function on(channel, callback) {
  const allowedChannels = [
    'log',
    'progress',
    'game-state',
    'updater-status',
    'auth-code'
  ];

  if (!allowedChannels.includes(channel)) {
    throw new Error('Canal événementiel non autorisé.');
  }

  const listener = (_event, payload) => callback(payload);

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  invoke,
  on
});
