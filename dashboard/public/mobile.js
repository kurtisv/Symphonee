// Symphonee Mobile : navigation et accueil. Aucun jeton, aucun innerHTML avec des donnees du serveur.
(function () {
  'use strict';
  var content = document.getElementById('content');
  var status = document.getElementById('status');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.nav-bar .col'));

  function card(title, body) {
    var c = document.createElement('section');
    c.className = 'card';
    var h = document.createElement('h2');
    h.textContent = title;
    c.appendChild(h);
    c.appendChild(body);
    return c;
  }

  function pre(text) {
    var p = document.createElement('pre');
    p.textContent = text;
    return p;
  }

  function muted(text) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    return p;
  }

  // Une session expiree renvoie vers la page de connexion.
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { window.location.replace('/remote'); throw new Error('session'); }
      return r.json();
    });
  }

  function showHome() {
    content.replaceChildren();
    content.appendChild(muted('Chargement...'));
    Promise.all([getJson('/api/busy'), getJson('/api/orchestrator/agents')]).then(function (res) {
      content.replaceChildren();
      content.appendChild(card('Etat du PC', pre(JSON.stringify(res[0], null, 2))));
      content.appendChild(card('Agents et terminaux', pre(JSON.stringify(res[1], null, 2))));
      status.textContent = 'en ligne';
    }).catch(function (e) {
      if (e && e.message === 'session') return;
      content.replaceChildren(card('Erreur', muted('Impossible de joindre Symphonee.')));
      status.textContent = 'hors ligne';
    });
  }

  function showSoon(title) {
    content.replaceChildren(card(title, muted('Bientot disponible.')));
  }

  // ---- Terminal : consultation en direct (lecture seule, le serveur refuse toute saisie du telephone) ----
  var term = { ws: null, timer: null, retry: 0, current: null, buffers: {}, list: [], out: null, chips: null, note: null };
  var MAX_CHARS = 20000;

  // Retire les sequences d'echappement ANSI et les retours chariot : on affiche du texte brut.
  function cleanAnsi(s) {
    return String(s)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
      .replace(/\x1b[()][A-Za-z0-9]/g, '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '');
  }

  function renderTerm() {
    if (!term.out) return;
    term.out.textContent = term.buffers[term.current] || '(aucune sortie depuis la connexion)';
    term.out.parentNode.scrollTop = term.out.parentNode.scrollHeight;
  }

  function renderChips() {
    if (!term.chips) return;
    term.chips.replaceChildren();
    term.list.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.style.cssText = 'width:auto;display:inline-block;margin:0 8px 8px 0;min-height:44px;padding:8px 14px;' + (t.id === term.current ? 'background:#2f81f7' : '');
      b.textContent = t.label || t.id;
      b.addEventListener('click', function () { term.current = t.id; renderChips(); renderTerm(); });
      term.chips.appendChild(b);
    });
  }

  function onTermMessage(raw) {
    var m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'term-list' && Array.isArray(m.terminals)) {
      term.list = m.terminals.map(function (t) { return { id: String(t.id), label: t.label ? String(t.label) : null }; });
      if (!term.current && term.list.length) term.current = term.list[0].id;
      renderChips(); renderTerm();
    } else if (m.type === 'output' && m.termId) {
      var id = String(m.termId);
      term.buffers[id] = ((term.buffers[id] || '') + cleanAnsi(m.data)).slice(-MAX_CHARS);
      if (!term.list.some(function (t) { return t.id === id; })) { term.list.push({ id: id, label: null }); renderChips(); }
      if (id === term.current) renderTerm();
    } else if (m.type === 'term-started' && m.termId) {
      if (!term.list.some(function (t) { return t.id === String(m.termId); })) { term.list.push({ id: String(m.termId), label: null }); renderChips(); }
    } else if (m.type === 'term-exited' && m.termId) {
      term.list = term.list.filter(function (t) { return t.id !== String(m.termId); });
      if (term.current === String(m.termId)) term.current = term.list.length ? term.list[0].id : null;
      renderChips(); renderTerm();
    }
  }

  function connectTerm() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/');
    term.ws = ws;
    ws.onopen = function () { term.retry = 0; if (term.note) term.note.textContent = 'Connecte - lecture seule (la saisie est desactivee sur le telephone).'; };
    ws.onmessage = function (e) { onTermMessage(e.data); };
    ws.onclose = function () {
      if (term.ws !== ws) return; // fermeture voulue
      if (term.note) term.note.textContent = 'Deconnecte, nouvelle tentative...';
      term.retry = Math.min(term.retry + 1, 6);
      term.timer = setTimeout(connectTerm, 1000 * term.retry);
    };
  }

  function stopTerm() {
    clearTimeout(term.timer);
    var ws = term.ws; term.ws = null;
    if (ws) { try { ws.close(); } catch (e) {} }
    term.out = term.chips = term.note = null;
  }

  function showTerminal() {
    content.replaceChildren();
    var chips = document.createElement('div');
    var note = muted('Connexion...');
    var box = document.createElement('div');
    box.style.cssText = 'max-height:55vh;overflow-y:auto;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-top:8px;';
    var out = pre('');
    box.appendChild(out);
    var c = document.createElement('div');
    c.appendChild(chips); c.appendChild(note); c.appendChild(box);
    content.appendChild(card('Terminaux du PC', c));
    term.chips = chips; term.note = note; term.out = out;
    renderChips(); renderTerm();
    if (!term.ws) connectTerm();
  }

  var pages = {
    home: showHome,
    terminal: showTerminal,
    mind: function () { showSoon('Mind'); },
    autopilotes: function () { showSoon('Autopilotes'); },
    projets: function () { showSoon('Projets'); }
  };

  function go(name) {
    if (name !== 'terminal') stopTerm();
    buttons.forEach(function (b) {
      if (b.getAttribute('data-page') === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    (pages[name] || pages.home)();
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-page')); });
  });

  go('home');
})();
