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

  var pages = {
    home: showHome,
    terminal: function () { showSoon('Terminal'); },
    mind: function () { showSoon('Mind'); },
    autopilotes: function () { showSoon('Autopilotes'); },
    projets: function () { showSoon('Projets'); }
  };

  function go(name) {
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
