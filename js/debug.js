/*
 * debug.js
 * ---------------------------------------------------------------------------
 * Developer testing panel. Only created when HS.config.DEBUG_MODE === true
 * (set it in js/utils.js). With DEBUG_MODE false this file does nothing.
 *
 * The panel shows counts and state-machine info. It deliberately does NOT
 * print anybody's hand or hidden cards on screen; use "Dump state to console"
 * if you really need the full secret state while developing.
 */
'use strict';

(function (HS) {
  let app = null;
  let api = null;
  const $ = function (id) { return document.getElementById(id); };

  function init(appRef, apiRef) {
    app = appRef;
    api = apiRef;
    const panel = $('debug-panel');
    panel.hidden = false;
    panel.innerHTML =
      '<div class="debug__header"><strong>🧪 Debug panel</strong>' +
      '<button type="button" class="icon-btn icon-btn--small" data-dbg="collapse">▾</button></div>' +
      '<div class="debug__body">' +
      '<div class="debug__section"><div class="debug__label">Automated tests</div>' +
      '<button type="button" class="btn btn--small" data-dbg="run-tests">Run all rule tests</button>' +
      '<button type="button" class="btn btn--small" data-dbg="verify">Verify live game (52 / duplicates)</button></div>' +

      '<div class="debug__section"><div class="debug__label">Load scenario (pass &amp; play, forced hands)</div>' +
      Object.keys(HS.tests.SCENARIOS).map(function (key) {
        return '<button type="button" class="btn btn--small" data-dbg="scenario" data-key="' + key + '">' +
          HS.tests.SCENARIOS[key].label + '</button>';
      }).join('') + '</div>' +

      '<div class="debug__section"><div class="debug__label">Deterministic deck</div>' +
      '<input type="number" id="dbg-seed" value="12345" class="debug__input">' +
      '<button type="button" class="btn btn--small" data-dbg="seed">Start with seed</button></div>' +

      '<div class="debug__section"><div class="debug__label">Force (before first card of a round)</div>' +
      '<select id="dbg-player" class="debug__input"></select>' +
      '<button type="button" class="btn btn--small" data-dbg="force-player">Force starter</button>' +
      '<select id="dbg-suit" class="debug__input">' +
      HS.SUITS.map(function (s) { return '<option value="' + s.key + '">' + s.symbol + ' ' + s.name + '</option>'; }).join('') +
      '</select><button type="button" class="btn btn--small" data-dbg="force-suit">Force lead suit</button></div>' +

      '<div class="debug__section"><button type="button" class="btn btn--small" data-dbg="dump">Dump state to console</button></div>' +
      '<pre id="dbg-info" class="debug__info"></pre>' +
      '<div id="dbg-results" class="debug__results"></div>' +
      '</div>';

    panel.addEventListener('click', onClick);
    refresh();
  }

  function onClick(event) {
    const btn = event.target.closest('[data-dbg]');
    if (!btn) return;
    const engine = app.engine;
    try {
      switch (btn.dataset.dbg) {
        case 'collapse':
          $('debug-panel').classList.toggle('debug-panel--collapsed');
          break;
        case 'run-tests':
          showResults(HS.tests.runAll());
          break;
        case 'verify':
          verifyLiveGame(engine);
          break;
        case 'scenario':
          api.startGame({ scenarioKey: btn.dataset.key, mode: 'pass' });
          break;
        case 'seed':
          api.startGame({ seed: Number($('dbg-seed').value) });
          break;
        case 'force-player':
          if (engine) engine.debugForceCurrentPlayer(Number($('dbg-player').value));
          break;
        case 'force-suit':
          if (engine) engine.debugForceActiveSuit($('dbg-suit').value);
          break;
        case 'dump':
          console.log('[Hidden Suit] SECRET engine state:', engine ? engine.state : null);
          break;
      }
    } catch (err) {
      HS.ui.showToast(err.message, 'error');
    }
  }

  function verifyLiveGame(engine) {
    const lines = [];
    const deck = HS.deck.createDeck();
    lines.push({ name: 'Fresh deck has exactly 52 unique cards', passed: deck.length === 52, messages: [] });
    if (engine) {
      let ok = true;
      let msg = '';
      try { engine.validateGameIntegrity(); } catch (err) { ok = false; msg = err.message; }
      lines.push({ name: 'Live game: no duplicates, card total = ' + engine.state.totalCards, passed: ok, messages: msg ? [msg] : [] });
    }
    showResults(lines);
  }

  function showResults(results) {
    const passed = results.filter(function (r) { return r.passed; }).length;
    $('dbg-results').innerHTML = '<div class="debug__summary">' + passed + '/' + results.length + ' passed</div>' +
      results.map(function (r) {
        return '<div class="debug__result debug__result--' + (r.passed ? 'pass' : 'fail') + '">' +
          (r.passed ? '✓ ' : '✗ ') + HS.utils.escapeHtml(r.name) +
          r.messages.map(function (m) { return '<div class="debug__msg">' + HS.utils.escapeHtml(m) + '</div>'; }).join('') +
          '</div>';
      }).join('');
  }

  /** Public-safe live info (counts and state only — never card identities). */
  function refresh() {
    if (!app) return;
    const info = $('dbg-info');
    const select = $('dbg-player');
    if (!app.engine || !app.engine.state) { info.textContent = 'No local engine on this device.'; select.innerHTML = ''; return; }
    const s = app.engine.getPublicState();
    info.textContent =
      'status: ' + s.status + '\n' +
      'round: ' + s.roundNumber + '  activeSuit: ' + s.activeSuit + '\n' +
      'current: ' + s.currentPlayerId + '  starter: ' + s.roundStarterId + '\n' +
      'hand sizes: ' + s.players.map(function (p) { return p.handCount; }).join(', ') + '\n' +
      'discarded: ' + s.discardedCount + '  total cards: ' + app.engine.state.totalCards;
    const current = select.value;
    select.innerHTML = s.players.filter(function (p) { return p.status === 'active'; }).map(function (p) {
      return '<option value="' + p.id + '">' + HS.utils.escapeHtml(p.name) + '</option>';
    }).join('');
    if (current) select.value = current;
  }

  HS.debug = { init: init, refresh: refresh };
})(window.HiddenSuit);
