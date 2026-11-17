// Symphonee Mobile : interface telephone (meme serveur, memes donnees que le PC).
// Securite : aucun jeton, jamais d'innerHTML avec des donnees du serveur (textContent seulement).
(function () {
  'use strict';
  var content = document.getElementById('content');
  var status = document.getElementById('status');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.nav-bar .col'));
  var homeTimer = null;
  var current = 'home';
  // Page modules written as separate small files register here: window.SymMobilePages.<name> = function (M, ...) {...}
  window.SymMobilePages = window.SymMobilePages || {};

  // ---------- utilitaires d'affichage ----------
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function card(title, body) {
    var c = h('section', 'card');
    c.appendChild(h('h2', null, title));
    if (body) c.appendChild(body);
    return c;
  }
  function muted(text) { return h('p', 'muted', text); }
  function pre(text) { return h('pre', null, text); }
  function row(left, right, cls) {
    var r = h('div', 'row' + (cls ? ' ' + cls : ''));
    r.appendChild(h('span', 'l', left));
    if (right !== undefined && right !== null && right !== '') r.appendChild(h('span', 'r', right));
    return r;
  }
  function list(rows, empty) {
    var d = h('div');
    if (!rows.length) d.appendChild(muted(empty || 'Rien a afficher.'));
    rows.forEach(function (x) { d.appendChild(x); });
    return d;
  }
  function loading() { var d = h('div'); d.appendChild(muted('Chargement...')); return d; }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '...' : s; }
  function hhmm(ts) { var d = new Date(ts); return isNaN(d) ? '' : d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }); }
  function arr(x, keys) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === 'object') for (var i = 0; i < (keys || []).length; i++) if (Array.isArray(x[keys[i]])) return x[keys[i]];
    return [];
  }

  // ---------- reseau (cookie de session uniquement) ----------
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      if (r.status === 401) { window.location.replace('/remote'); throw new Error('session'); }
      return r.json().catch(function () { return null; }).then(function (j) { return { status: r.status, json: j }; });
    });
  }
  function getJson(url) { return api('GET', url).then(function (r) { return r.json; }); }
  function quiet(p) { return p.catch(function (e) { if (e && e.message === 'session') throw e; return null; }); }

  // ---------- Accueil ----------
  function renderHome(box, d) {
    box.replaceChildren();
    var pend = arr(d.pending);
    if (pend.length) {
      var w = card('A valider sur le PC', list(pend.map(function (p) { return row((p.action && p.action.type) || '?', clip(p.action && p.action.value, 90)); })));
      w.className += ' warn';
      box.appendChild(w);
    }
    var st = (d.stats && d.stats.stats) || {};
    box.appendChild(card('Le PC', list([
      row('Etat', 'en ligne'),
      row('Mind', (st.nodes || 0) + ' noeuds, ' + (st.edges || 0) + ' liens'),
      row('Mis a jour', hhmm(Date.now()))
    ])));
    var agents = arr(d.agents);
    box.appendChild(card('Terminaux et agents (' + agents.length + ')', list(agents.map(function (a) { return row(a.termId, a.cols + 'x' + a.rows + (a.alive ? '' : ' - arrete')); }), 'Aucun terminal.')));
    var tasks = arr(d.tasks, ['tasks']);
    box.appendChild(card('Taches (' + tasks.length + ')', list(tasks.slice(0, 6).map(function (t) { return row(clip(t.cli || t.type || t.id, 24), t.state || t.status || ''); }), 'Aucune tache en cours.')));
    var pilots = arr(d.pilots, ['pilots']);
    box.appendChild(card('Autopilotes', list(pilots.map(function (p) {
      var t = p.today || {};
      return row(p.label || p.pilot, (p.status || '') + ' - ' + (t.completed || 0) + ' fait(s)');
    }), 'Aucun autopilote.')));
    var jobs = arr(d.jobs);
    box.appendChild(card('Boucles planifiees', list(jobs.slice(0, 8).map(function (j) {
      return row(clip(j.name || j.id, 36), (j.enabled === false ? 'desactivee' : j.schedule || ''));
    }), 'Aucune boucle planifiee.')));
    var errs = arr(d.ledger, ['entries']).filter(function (e) { return e.outcome && e.outcome !== 'ok'; }).slice(0, 6);
    box.appendChild(card('Erreurs recentes', list(errs.map(function (e) { return row(hhmm(e.ts) + ' ' + clip(e.action || e.resource, 30), e.outcome); }), 'Aucune erreur recente.')));
  }

  function loadHome(box) {
    return Promise.all([
      quiet(getJson('/api/orchestrator/agents')), quiet(getJson('/api/orchestrator/tasks')), quiet(getJson('/api/mind/autopilots')),
      quiet(getJson('/api/jobs')), quiet(getJson('/api/ledger?limit=40')), quiet(getJson('/api/permissions/pending')), quiet(getJson('/api/mind/stats'))
    ]).then(function (r) {
      if (current !== 'home') return;
      renderHome(box, { agents: r[0], tasks: r[1], pilots: r[2], jobs: r[3], ledger: r[4], pending: r[5], stats: r[6] });
      var np = arr(r[5]).length;
      status.textContent = np ? 'en ligne - ' + np + ' a valider sur le PC' : 'en ligne';
    }).catch(function (e) {
      if (e && e.message === 'session') return;
      status.textContent = 'hors ligne';
    });
  }

  function showHome() {
    var box = h('div');
    box.appendChild(muted('Chargement...'));
    content.replaceChildren(box);
    loadHome(box);
    homeTimer = setInterval(function () { if (current === 'home') loadHome(box); }, 10000);
  }

  // ---------- Terminal ----------
  var T = { ws: null, timer: null, retry: 0, cur: null, picked: false, list: [], buf: {}, size: {}, xt: null, host: null, chips: null, note: null, fallback: null };
  var MAX_BUF = 120000;

  function plain(s) {
    return String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  }
  function drawTerm() {
    if (!T.cur) return;
    var text = T.buf[T.cur] || '';
    if (T.xt) { T.xt.reset(); if (text) T.xt.write(text); }
    else if (T.fallback) { T.fallback.textContent = plain(text) || '(aucune sortie depuis la connexion)'; T.fallback.parentNode.scrollTop = T.fallback.parentNode.scrollHeight; }
  }
  function sizeFor(id) { var s = T.size[id] || {}; return { cols: Math.min(s.cols || 100, 160), rows: Math.min(s.rows || 30, 60) }; }
  function useTerm(id) {
    T.cur = id;
    if (T.xt) { var s = sizeFor(id); T.xt.resize(s.cols, s.rows); }
    drawChips(); drawTerm();
  }
  function drawChips() {
    if (!T.chips) return;
    T.chips.replaceChildren();
    T.list.forEach(function (id) {
      var b = h('button', 'chip' + (id === T.cur ? ' on' : ''), id);
      b.addEventListener('click', function () { T.picked = true; useTerm(id); });
      T.chips.appendChild(b);
    });
  }
  // Le terminal principal (main) est choisi par defaut, sauf si l'utilisateur en a touche un autre.
  function addTerm(id) { if (T.list.indexOf(id) < 0) { T.list.push(id); drawChips(); } if (!T.cur || (id === 'main' && !T.picked)) T.cur = id; }

  function onTermMessage(raw) {
    var m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'term-list' && Array.isArray(m.terminals)) {
      m.terminals.forEach(function (t) { addTerm(String(t.id)); });
      if (T.cur) useTerm(T.cur);
    } else if (m.type === 'output' && m.termId) {
      var id = String(m.termId); addTerm(id);
      T.buf[id] = ((T.buf[id] || '') + String(m.data)).slice(-MAX_BUF);
      if (id === T.cur) { if (T.xt) T.xt.write(String(m.data)); else drawTerm(); }
    } else if (m.type === 'term-started' && m.termId) {
      addTerm(String(m.termId));
    } else if (m.type === 'term-exited' && m.termId) {
      T.list = T.list.filter(function (x) { return x !== String(m.termId); });
      if (T.cur === String(m.termId)) T.cur = T.list[0] || null;
      drawChips(); drawTerm();
    }
  }
  function connectTerm() {
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
    T.ws = ws;
    ws.onopen = function () { T.retry = 0; if (T.note) T.note.textContent = 'Connecte. Affichage en direct, la saisie directe est desactivee.'; };
    ws.onmessage = function (e) { onTermMessage(e.data); };
    ws.onclose = function () {
      if (T.ws !== ws) return;
      if (T.note) T.note.textContent = 'Deconnecte, nouvelle tentative...';
      T.retry = Math.min(T.retry + 1, 6);
      T.timer = setTimeout(connectTerm, 1000 * T.retry);
    };
  }
  function stopTerm() {
    clearTimeout(T.timer);
    var ws = T.ws; T.ws = null;
    if (ws) { try { ws.close(); } catch (e) {} }
    if (T.xt) { try { T.xt.dispose(); } catch (e) {} }
    T.xt = null; T.host = T.chips = T.note = T.fallback = null;
  }

  var CMD_MSG = {
    sent: 'Envoye au terminal.',
    denied: 'Refuse sur le PC.',
    timeout: 'Delai de 90 s depasse : rien n a ete envoye.',
    failed: 'Echec de l envoi au terminal.',
    CONTROL_CHARS: 'Une seule ligne de texte, sans caractere special.',
    EMPTY: 'Saisissez une commande.',
    TOO_LONG: 'Commande trop longue (2000 caracteres max).',
    UNKNOWN_TERMINAL: 'Ce terminal n existe plus.',
    ALREADY_PENDING: 'Une commande attend deja votre accord sur le PC.',
    TOO_MANY_PENDING: 'Trop de demandes en attente sur le PC.'
  };

  function showTerminal() {
    var box = h('div');
    T.chips = h('div', 'chips');
    T.note = muted('Connexion...');
    var host = h('div', 'termbox');
    T.host = host;
    if (typeof window.Terminal === 'function') {
      T.xt = new window.Terminal({ disableStdin: true, cursorBlink: false, fontSize: 10, scrollback: 3000, cols: 100, rows: 30, theme: { background: '#0d0d0d' } });
      T.xt.open(host);
    } else {
      T.fallback = pre('');
      host.appendChild(T.fallback);
    }
    // Envoi d'une commande : toujours validee sur le PC (jamais de BYPASS).
    var form = h('form', 'cmd');
    var input = h('input'); input.type = 'text'; input.maxLength = 2000; input.placeholder = 'Commande a envoyer au terminal...';
    input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'none'); input.setAttribute('spellcheck', 'false'); input.setAttribute('enterkeyhint', 'send');
    var send = h('button', 'btn', 'Envoyer au PC (a valider sur le PC)'); send.type = 'submit';
    var res = muted('');
    form.appendChild(input); form.appendChild(send); form.appendChild(res);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!T.cur) { res.textContent = 'Aucun terminal selectionne.'; return; }
      var text = input.value;
      send.disabled = true; res.textContent = 'En attente de votre accord sur le PC (90 s)...';
      api('POST', '/api/remote/terminal/command', { termId: T.cur, text: text }).then(function (r) {
        var j = r.json || {};
        res.textContent = CMD_MSG[j.status === 'refused' ? j.code : j.status] || ('Reponse inattendue (' + r.status + ').');
        if (j.status === 'sent') input.value = '';
      }).catch(function (err) { if (err && err.message !== 'session') res.textContent = 'Connexion impossible.'; })
        .then(function () { send.disabled = false; });
    });
    box.appendChild(T.chips); box.appendChild(T.note); box.appendChild(host); box.appendChild(form);
    content.replaceChildren(card('Terminaux du PC', box));
    quiet(getJson('/api/orchestrator/agents')).then(function (a) {
      arr(a).forEach(function (t) { T.size[t.termId] = { cols: t.cols, rows: t.rows }; addTerm(String(t.termId)); });
      if (T.cur) useTerm(T.cur);
    });
    drawChips();
    connectTerm();
  }

  // ---------- Mind ----------
  function showMind() {
    var box = h('div');
    content.replaceChildren(box);
    var form = h('form', 'cmd');
    var q = h('input'); q.type = 'search'; q.placeholder = 'Chercher dans la memoire...'; q.setAttribute('enterkeyhint', 'search');
    var go = h('button', 'btn', 'Chercher'); go.type = 'submit';
    var results = h('div');
    form.appendChild(q); form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!q.value.trim()) return;
      results.replaceChildren(muted('Recherche...'));
      api('POST', '/api/mind/recall', { question: q.value.trim(), limit: 8 }).then(function (r) {
        var hits = arr(r.json, ['hits']);
        results.replaceChildren(list(hits.map(function (x) {
          var d = h('div', 'hit');
          d.appendChild(h('div', 'hit-t', (x.kindOfMemory ? '[' + x.kindOfMemory + '] ' : '') + clip(x.label || x.id, 120)));
          if (x.snippet && x.snippet !== x.label) d.appendChild(h('div', 'muted', clip(x.snippet, 280)));
          return d;
        }), 'Aucun resultat.'));
      }).catch(function (err) { if (err && err.message !== 'session') results.replaceChildren(muted('Recherche impossible.')); });
    });
    box.appendChild(card('Rechercher dans Mind', (function () { var d = h('div'); d.appendChild(form); d.appendChild(results); return d; })()));
    var statsBox = loading(), learnBox = loading(), wakeBox = loading();
    box.appendChild(card('Etat de la memoire', statsBox));
    box.appendChild(card('Apprentissages', learnBox));
    box.appendChild(card('Souvenirs recents', wakeBox));
    quiet(getJson('/api/mind/stats')).then(function (s) {
      var st = (s && s.stats) || {};
      statsBox.replaceChildren(list([row('Noeuds', st.nodes), row('Liens', st.edges), row('Communautes', st.communities), row('Derniere mise a jour', st.lastBuildAt ? hhmm(st.lastBuildAt) : '')], 'Indisponible.'));
    });
    quiet(getJson('/api/learnings')).then(function (l) {
      learnBox.replaceChildren(list(arr(l).slice(-12).reverse().map(function (x) {
        var d = h('div', 'hit'); d.appendChild(h('div', 'hit-t', '[' + (x.category || '?') + '] ' + clip(x.summary, 160))); return d;
      }), 'Aucun apprentissage.'));
    });
    quiet(getJson('/api/mind/wakeup')).then(function (w) {
      wakeBox.replaceChildren(w && w.text ? pre(clip(w.text, 2500)) : muted('Indisponible.'));
    });
  }

  // ---------- Autopilotes ----------
  function showAutopilots() {
    var box = h('div');
    content.replaceChildren(box);
    var a = loading(), j = loading();
    box.appendChild(card('Autopilotes', a));
    box.appendChild(card('Boucles planifiees', j));
    box.appendChild(card('Controles', muted('Demarrer, arreter ou modifier un autopilote se fait depuis le PC. Le telephone consulte seulement.')));
    quiet(getJson('/api/mind/autopilots')).then(function (r) {
      a.replaceChildren(list(arr(r, ['pilots']).map(function (p) {
        var d = h('div', 'hit'), t = p.today || {}, l = p.limits || {};
        d.appendChild(h('div', 'hit-t', (p.label || p.pilot) + ' - ' + (p.status || '?')));
        d.appendChild(h('div', 'muted', (p.profileLabel || '') + (p.repoName ? ' - ' + p.repoName : '')));
        d.appendChild(h('div', 'muted', 'Aujourd hui : ' + (t.completed || 0) + '/' + (l.dailyCompletions || '?') + ' fait(s), ' + (t.discoveries || 0) + '/' + (l.dailyDiscoveries || '?') + ' decouverte(s)'));
        return d;
      }), 'Aucun autopilote.'));
    });
    quiet(getJson('/api/jobs')).then(function (r) {
      j.replaceChildren(list(arr(r).map(function (x) {
        var d = h('div', 'hit'), lr = x.lastRun || {};
        d.appendChild(h('div', 'hit-t', clip(x.name || x.id, 80)));
        d.appendChild(h('div', 'muted', (x.enabled === false ? 'desactivee' : x.schedule || '') + (lr.status || lr.state ? ' - dernier : ' + (lr.status || lr.state) : '') + (lr.at || lr.finishedAt || lr.startedAt ? ' ' + hhmm(lr.at || lr.finishedAt || lr.startedAt) : '')));
        return d;
      }), 'Aucune boucle planifiee.'));
    });
  }

  // ---------- Projets ----------
  function showProjects() {
    var box = h('div');
    content.replaceChildren(box);
    var chips = h('div', 'chips'), detail = h('div');
    chips.appendChild(muted('Chargement...'));
    box.appendChild(card('Projets', chips));
    box.appendChild(detail);
    function open(name) {
      Array.prototype.forEach.call(chips.children, function (b) { b.className = 'chip' + (b.textContent === name ? ' on' : ''); });
      detail.replaceChildren(muted('Chargement...'));
      var q = '?repo=' + encodeURIComponent(name);
      Promise.all([quiet(getJson('/api/git/status' + q)), quiet(getJson('/api/git/branches' + q)), quiet(getJson('/api/git/log' + q + '&count=8')), quiet(getJson('/api/github/pulls' + q + '&state=open'))]).then(function (r) {
        detail.replaceChildren();
        var s = r[0] || {};
        var files = arr(s.files);
        detail.appendChild(card('Branche et modifications', list([
          row('Branche', s.branch || '(inconnue)'),
          row('Modifications', s.clean ? 'aucune' : files.length + ' fichier(s)')
        ].concat(files.slice(0, 12).map(function (f) { return row(clip(f.path || f.file || f.name || (typeof f === 'string' ? f : JSON.stringify(f)), 44), f.status || f.x || ''); })))));
        var br = arr(r[1], ['branches']);
        detail.appendChild(card('Branches (' + br.length + ')', list(br.slice(0, 15).map(function (b) { return row(clip(typeof b === 'string' ? b : (b.name || ''), 48), b.current ? 'actuelle' : ''); }), 'Aucune branche lisible.')));
        var cm = arr(r[2], ['commits']);
        detail.appendChild(card('Derniers commits', list(cm.map(function (c) { return row(clip(c.message || c.subject || c.title || '', 50), String(c.hash || c.sha || '').slice(0, 7)); }), 'Aucun commit.')));
        var fbtn = h('button', 'btn', 'Parcourir les fichiers (lecture seule)');
        var fbox = h('div');
        fbtn.addEventListener('click', function () {
          var f = window.SymMobilePages && window.SymMobilePages.files;
          if (typeof f !== 'function') { fbox.replaceChildren(muted('Indisponible.')); return; }
          try { f(M, name, fbox); } catch (e) { fbox.replaceChildren(muted('Erreur du navigateur de fichiers.')); }
        });
        detail.appendChild(card('Fichiers', (function () { var d = h('div'); d.appendChild(fbtn); d.appendChild(fbox); return d; })()));
        var prs = arr(r[3], ['pulls', 'pullRequests', 'items']);
        detail.appendChild(card('Pull requests ouvertes (' + prs.length + ')', list(prs.slice(0, 10).map(function (p) { return row('#' + p.number + ' ' + clip(p.title, 40), p.author || (p.user && p.user.login) || ''); }), (r[3] && r[3].error) ? 'Indisponible : ' + r[3].error : 'Aucune pull request ouverte.')));
      });
    }
    quiet(getJson('/api/repos')).then(function (repos) {
      var names = repos && typeof repos === 'object' ? Object.keys(repos) : [];
      chips.replaceChildren();
      if (!names.length) chips.appendChild(muted('Aucun projet.'));
      names.forEach(function (n) { var b = h('button', 'chip', n); b.addEventListener('click', function () { open(n); }); chips.appendChild(b); });
      if (names.length) open(names[0]);
    });
  }

  // Helpers given to the page modules (settings, files). Read-only API access, no token.
  var M = { h: h, card: card, muted: muted, pre: pre, row: row, list: list, clip: clip, hhmm: hhmm, arr: arr, api: api, getJson: getJson, quiet: quiet, content: content, status: status };
  function modulePage(name, title) {
    var f = window.SymMobilePages && window.SymMobilePages[name];
    if (typeof f !== 'function') { content.replaceChildren(card(title, muted('Indisponible.'))); return; }
    try { f(M); } catch (e) { content.replaceChildren(card(title, muted('Cette page a rencontre une erreur.'))); }
  }

  // ---------- navigation ----------
  var pages = {
    settings: function () { modulePage('settings', 'Reglages'); }, home: showHome, terminal: showTerminal, mind: showMind, autopilotes: showAutopilots, projets: showProjects };
  function go(name) {
    clearInterval(homeTimer); homeTimer = null;
    if (name !== 'terminal') stopTerm();
    current = name;
    buttons.forEach(function (b) {
      if (b.getAttribute('data-page') === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    (pages[name] || pages.home)();
  }
  buttons.forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-page')); }); });
  var gear = document.getElementById('gear');
  if (gear) gear.addEventListener('click', function () { go('settings'); });
  go('home');
})();
