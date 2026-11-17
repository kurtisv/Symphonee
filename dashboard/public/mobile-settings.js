window.SymMobilePages = window.SymMobilePages || {};
window.SymMobilePages.settings = function (M) {
  'use strict';
  // Page Reglages : session, application, securite. Aucun jeton, textContent uniquement.
  var session = M.h('div');
  session.appendChild(M.row('Appareil', 'Telephone'));
  var etat = M.row('Connexion', 'verification...');
  session.appendChild(etat);
  var out = M.h('button', 'btn', 'Se deconnecter');
  out.addEventListener('click', function () {
    out.disabled = true;
    M.api('POST', '/api/remote/logout', {}).then(function () { window.location.replace('/remote'); })
      .catch(function () { out.disabled = false; });
  });
  session.appendChild(out);

  var app = M.h('div');
  app.appendChild(M.row('Version', 'Symphonee Mobile V1'));
  app.appendChild(M.muted('Installer : menu des trois points de Chrome, puis Installer l application.'));

  var secu = M.h('div');
  secu.appendChild(M.muted('Les commandes envoyees depuis le telephone doivent etre approuvees sur le PC, meme en mode BYPASS.'));
  secu.appendChild(M.muted('Le telephone lit les fichiers des projets en lecture seule ; les fichiers de configuration et les secrets ne sont jamais accessibles.'));

  M.content.replaceChildren(M.card('Session', session), M.card('Application', app), M.card('Securite', secu));

  M.quiet(M.getJson('/api/remote/session')).then(function (s) {
    etat.replaceChildren(M.h('span', 'l', 'Connexion'), M.h('span', 'r', s && s.authenticated ? 'active' : 'inconnue'));
  });
};
