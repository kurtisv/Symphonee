'use strict';
// remote-settings -- the one switch that decides how a phone command is treated.
//   'auto' : a valid command line goes straight to the terminal (the owner is away from the PC);
//            destructive-looking commands still ask for approval on the PC (see remote-command.js).
//   'ask'  : every command waits for approval on the PC.
// Stored in a small file next to the paired sessions; the PC can change it (PC-only route, scripts/mobile-pair.js).
// Default 'auto': the owner asked for phone commands to work without being at the PC.

const fs = require('fs');
const path = require('path');

const MODES = ['auto', 'ask'];

function createRemoteSettings({ filePath }) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return MODES.includes(j && j.commandMode) ? j.commandMode : 'auto';
    } catch (_) { return 'auto'; }
  }
  function setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('bad_mode');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ commandMode: mode, changedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return mode;
  }
  return { getMode: read, setMode, MODES };
}

module.exports = { createRemoteSettings, MODES };
