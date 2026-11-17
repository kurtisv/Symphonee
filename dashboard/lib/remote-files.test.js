'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rf = require('./remote-files');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-rf-'));
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  w('README.md', '# Projet\nBonjour');
  w('src/app.js', 'console.log("ok");');
  w('src/notes.txt', 'texte');
  w('src/image.png', 'binaire');
  w('config/config.json', '{"GitHubPAT":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}');
  w('config/runtime.json', '{"token":"deadbeefdeadbeefdeadbeefdeadbeef"}');
  w('.env', 'API_KEY=supersecretvalue1234567890');
  w('.git/config', '[core]');
  w('node_modules/x/index.js', 'x');
  w('src/secrets.js', 'module.exports = 1');
  w('src/api-token.js', 'module.exports = 2');
  w('src/leak.js', 'const apiKey = "abcdefghijklmnop1234567890";');
  w('src/pem.js', '-----BEGIN RSA PRIVATE KEY-----\nxx\n-----END RSA PRIVATE KEY-----');
  w('src/gh.js', 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";');
  w('src/big.txt', 'a'.repeat(rf.MAX_BYTES + 1));
  return root;
}

test('lecture normale : un fichier texte du depot', () => {
  const r = rf.readFile(repo(), 'src/app.js');
  assert.equal(r.ok, true);
  assert.match(r.text, /console\.log/);
  assert.equal(rf.readFile(repo(), 'README.md').ok, true);
});

test('listing : dossiers puis fichiers texte, sans cache ni secret ni binaire', () => {
  const root = repo();
  const l = rf.listDir(root, '');
  assert.equal(l.ok, true);
  const names = l.entries.map(e => e.name);
  assert.ok(names.includes('src') && names.includes('README.md'));
  for (const bad of ['.env', '.git', 'node_modules', 'config']) assert.ok(!names.includes(bad), bad + ' ne doit pas apparaitre');
  const src = rf.listDir(root, 'src').entries.map(e => e.name);
  assert.ok(src.includes('app.js') && src.includes('notes.txt'));
  for (const bad of ['image.png', 'secrets.js', 'api-token.js']) assert.ok(!src.includes(bad), bad + ' ne doit pas apparaitre');
});

test('fichiers sensibles : refuses par leur chemin, meme si on connait le nom', () => {
  const root = repo();
  for (const p of ['config/runtime.json', 'config/config.json', '.env', '.git/config', 'node_modules/x/index.js', 'src/secrets.js', 'src/api-token.js']) {
    const r = rf.readFile(root, p);
    assert.equal(r.ok, false, p);
    assert.equal(r.code, 'FORBIDDEN', p);
  }
});

test('contenu qui ressemble a un secret : refuse meme dans un fichier au nom banal', () => {
  const root = repo();
  for (const p of ['src/leak.js', 'src/pem.js', 'src/gh.js']) {
    const r = rf.readFile(root, p);
    assert.equal(r.ok, false, p);
    assert.equal(r.code, 'SENSITIVE_CONTENT', p);
  }
});

test('traversee de chemin et chemins absolus : refuses', () => {
  const root = repo();
  for (const p of ['../x', 'src/../../etc/passwd', '..', 'src/..', './src/app.js', 'a\0b', 'C:/Windows/win.ini', '/etc/passwd', '\\\\serveur\\partage']) {
    const r = rf.readFile(root, p);
    assert.equal(r.ok, false, JSON.stringify(p));
  }
  assert.equal(rf.listDir(root, '../').ok, false);
});

test('type et taille : binaire et fichier trop gros refuses', () => {
  const root = repo();
  assert.equal(rf.readFile(root, 'src/image.png').code, 'NOT_TEXT');
  assert.equal(rf.readFile(root, 'src/big.txt').code, 'TOO_LARGE');
  assert.equal(rf.readFile(root, 'src').code, 'NOT_A_FILE');
  assert.equal(rf.listDir(root, 'src/app.js').code, 'NOT_A_DIRECTORY');
  assert.equal(rf.readFile(root, 'inexistant.js').code, 'NOT_FOUND');
});

test('depot invalide : refuse', () => {
  assert.equal(rf.readFile('', 'a.js').code, 'NO_REPO');
  assert.equal(rf.readFile(null, 'a.js').code, 'NO_REPO');
  assert.equal(rf.listDir('C:/inexistant/depot', '').code, 'NO_REPO');
});

test('lien symbolique qui sort du depot : refuse (si le systeme permet les liens)', (t) => {
  const root = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-out-'));
  fs.writeFileSync(path.join(outside, 'dehors.txt'), 'secret dehors');
  try { fs.symlinkSync(outside, path.join(root, 'lien'), 'junction'); } catch (e) { return t.skip('liens non disponibles : ' + e.code); }
  const r = rf.readFile(root, 'lien/dehors.txt');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN');
  assert.ok(!rf.listDir(root, '').entries.some(e => e.name === 'lien'), 'le lien ne doit pas etre liste');
});

test('lien visible vers un dossier cache du depot : refuse', (t) => {
  const root = repo();
  try { fs.symlinkSync(path.join(root, 'config'), path.join(root, 'visible'), 'junction'); } catch (e) { return t.skip('liens non disponibles : ' + e.code); }
  assert.equal(rf.readFile(root, 'visible/runtime.json').ok, false);
});

test('hiddenName : noms interdits', () => {
  for (const n of ['.env', '.git', 'node_modules', 'config', 'secrets', 'id_rsa', 'server.pem', 'my-token.txt', 'runtime.json']) assert.equal(rf.hiddenName(n), true, n);
  for (const n of ['README.md', 'app.js', 'index.html', 'package.json', 'src']) assert.equal(rf.hiddenName(n), false, n);
});
