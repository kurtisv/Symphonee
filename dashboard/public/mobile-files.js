window.SymMobilePages = window.SymMobilePages || {};
window.SymMobilePages.files = function (M, repo, box) {
  'use strict';
  // Navigateur de fichiers en lecture seule. Le serveur filtre tout ce qui est sensible (voir lib/remote-files.js).
  function url(kind, path) {
    return '/api/remote/' + kind + '?repo=' + encodeURIComponent(repo) + '&path=' + encodeURIComponent(path);
  }
  function parent(path) {
    var i = path.lastIndexOf('/');
    return i < 0 ? '' : path.slice(0, i);
  }
  function join(path, name) { return path ? path + '/' + name : name; }
  function button(label, fn) {
    var b = M.h('button', 'chip', label);
    b.addEventListener('click', fn);
    return b;
  }

  function open(path) {
    box.replaceChildren(M.muted('Chargement...'));
    M.quiet(M.getJson(url('file', path))).then(function (r) {
      var nodes = [button('Retour', function () { show(parent(path)); }), M.muted('/' + path)];
      nodes.push(r && r.ok ? M.pre(M.clip(r.text, 20000)) : M.muted('Fichier non affichable (' + (r && r.code ? r.code : 'erreur') + ')'));
      box.replaceChildren.apply(box, nodes);
    });
  }

  function show(path) {
    box.replaceChildren(M.muted('Chargement...'));
    M.quiet(M.getJson(url('files', path))).then(function (r) {
      if (!r || !r.ok) { box.replaceChildren(M.muted('Acces refuse ou introuvable (' + (r && r.code ? r.code : 'erreur') + ')')); return; }
      var nodes = [M.muted('/' + path)];
      if (path) nodes.push(button('Dossier parent', function () { show(parent(path)); }));
      var list = M.h('div', 'chips');
      (r.entries || []).forEach(function (e) {
        var full = join(path, e.name);
        list.appendChild(button((e.type === 'dir' ? '[dossier] ' : '') + e.name, function () { if (e.type === 'dir') show(full); else open(full); }));
      });
      if (!(r.entries || []).length) list.appendChild(M.muted('Dossier vide.'));
      nodes.push(list);
      box.replaceChildren.apply(box, nodes);
    });
  }

  show('');
};
