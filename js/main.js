/*
 * main.js
 * ---------------------------------------------------------------------------
 * The CONTROLLER. It connects the pieces:
 *
 *   user clicks ──► main.js ──► engine.dispatch(action)
 *                                   │ validateMove / applyMove
 *                                   ▼
 *                           'stateChanged' event
 *                                   │
 *   screen      ◄── ui.renderGame(publicState, privateView)
 *
 * It also owns everything that is about FLOW rather than RULES:
 *   - which player's private hand is currently visible (pass-and-play privacy)
 *   - AI turn timing, pause, modals, settings saved in localStorage
 */
'use strict';

(function (HS) {
  const S = HS.STATES;
  const A = HS.ACTIONS;
  const ui = HS.ui;
  const $ = function (id) { return document.getElementById(id); };

  const AI_NAMES = ['Ada', 'Blaze', 'Cipher', 'Dex', 'Echo', 'Flint', 'Gizmo', 'Hex', 'Ivy'];

  const DEFAULT_SETTINGS = {
    playerCount: 4,
    mode: 'ai',              // 'pass' | 'ai'
    playerNames: [],
    soundOn: true,
    aiSpeed: 'normal'
  };

  const App = {
    settings: null,
    engine: null,
    lastStartOptions: null,  // used by "Restart Game"
    revealedPlayerId: null,  // pass & play: whose hand is currently visible
    selectedCardId: null,
    selectedSuit: null,
    paused: false,
    flowLocked: false,       // true while a private confirmation is on screen
    aiTimer: null,
    resultTimer: null,
    resultShownForRound: null,
    gameOverShown: false,
    openModalKind: null,     // 'result' | 'gameover' while those dialogs are open
    lastTurnKey: null        // avoids repeating the "your turn" beep
  };

  /* ======================================================================
   * SETTINGS & MENU
   * =================================================================== */

  function loadSettings() {
    const saved = HS.utils.storage.load(HS.config.STORAGE_KEY, {});
    App.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    App.settings.playerCount = Math.min(HS.config.MAX_PLAYERS,
      Math.max(HS.config.MIN_PLAYERS, Number(App.settings.playerCount) || 4));
  }

  function saveSettings() {
    HS.utils.storage.save(HS.config.STORAGE_KEY, App.settings);
  }

  function buildMenu() {
    const countContainer = $('player-count-buttons');
    countContainer.innerHTML = '';
    for (let n = HS.config.MIN_PLAYERS; n <= HS.config.MAX_PLAYERS; n++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'count-btn';
      btn.dataset.count = n;
      btn.setAttribute('role', 'radio');
      btn.textContent = n;
      countContainer.appendChild(btn);
    }
    countContainer.addEventListener('click', function (event) {
      const btn = event.target.closest('[data-count]');
      if (!btn) return;
      App.settings.playerCount = Number(btn.dataset.count);
      saveSettings();
      refreshMenu();
    });

    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        App.settings.mode = btn.dataset.mode;
        saveSettings();
        refreshMenu();
      });
    });
    if (!HS.net.isAvailable()) {
      // Opened from file:// or offline — online rooms need Firebase and a web address.
      document.querySelector('.mode-btn[data-mode="online"]').disabled = true;
      if (App.settings.mode === 'online') App.settings.mode = 'ai';
    }

    $('ai-speed-select').addEventListener('change', function (e) {
      App.settings.aiSpeed = e.target.value;
      saveSettings();
    });
    $('sound-toggle-menu').addEventListener('change', function (e) {
      setSound(e.target.checked);
    });
    $('player-name-inputs').addEventListener('input', function (e) {
      const index = Number(e.target.dataset.index);
      App.settings.playerNames[index] = e.target.value.slice(0, 16);
      saveSettings();
    });

    $('btn-start').addEventListener('click', function () { startGame({}); });
    $('btn-menu-rules').addEventListener('click', ui.showRules);
    refreshMenu();
  }

  /** Re-draws the selected state of the menu controls. */
  function refreshMenu() {
    const s = App.settings;
    document.querySelectorAll('.count-btn').forEach(function (btn) {
      const on = Number(btn.dataset.count) === s.playerCount;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-checked', on);
    });
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      const on = btn.dataset.mode === s.mode;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-checked', on);
    });
    $('ai-speed-select').value = s.aiSpeed;
    $('sound-toggle-menu').checked = s.soundOn;

    const online = s.mode === 'online';
    $('local-count-section').hidden = online;
    $('btn-start').hidden = online;
    $('online-panel').hidden = !online;

    // Name inputs: in AI mode only Player 1 (you) is named; opponents are bots.
    // Online players type their name in the online panel instead.
    const inputCount = online ? 0 : s.mode === 'ai' ? 1 : s.playerCount;
    let html = '';
    for (let i = 0; i < inputCount; i++) {
      const label = s.mode === 'ai' ? 'Your name' : 'Player ' + (i + 1);
      html += '<label class="name-field"><span>' + label + '</span>' +
        '<input type="text" maxlength="16" data-index="' + i + '" placeholder="' + defaultName(i) + '" value="' +
        HS.utils.escapeHtml(s.playerNames[i] || '') + '"></label>';
    }
    $('player-name-inputs').innerHTML = html;
  }

  function defaultName(index) {
    return App.settings.mode === 'ai' && index === 0 ? 'You' : 'Player ' + (index + 1);
  }

  /** Player list for the engine, built from the current settings. */
  function buildPlayerDefinitions() {
    const s = App.settings;
    const defs = [];
    for (let i = 0; i < s.playerCount; i++) {
      const typed = (s.playerNames[i] || '').trim();
      if (s.mode === 'ai' && i > 0) {
        defs.push({ name: AI_NAMES[(i - 1) % AI_NAMES.length], type: 'ai' });
      } else {
        defs.push({ name: typed || defaultName(i), type: 'human' });
      }
    }
    return defs;
  }

  /* ======================================================================
   * GAME LIFECYCLE
   * =================================================================== */

  /**
   * Starts a game. options (all optional):
   *   seed         deterministic deck
   *   scenarioKey  load a test scenario from tests.js (debug panel)
   *   mode         override the mode (debug scenarios use pass & play)
   */
  function startGame(options) {
    teardownGame();
    App.lastStartOptions = options || {};
    App.mode = App.lastStartOptions.mode || App.settings.mode;

    const engine = new HS.GameEngine();
    attachEngineEvents(engine);
    App.engine = engine;

    if (App.lastStartOptions.scenarioKey) {
      const scenario = HS.tests.SCENARIOS[App.lastStartOptions.scenarioKey];
      const players = [];
      for (let i = 0; i < scenario.players; i++) players.push({ name: 'P' + (i + 1), type: 'human' });
      engine.initializeGame({ players: players, hands: scenario.hands, starterId: scenario.starterId });
    } else {
      engine.initializeGame({ players: buildPlayerDefinitions(), seed: App.lastStartOptions.seed });
    }

    ui.resetRenderMemory();
    ui.showScreen('game');
    document.body.classList.toggle('mode-pass', App.mode === 'pass');
    document.body.classList.toggle('mode-ai', App.mode === 'ai');
    document.body.classList.remove('mode-online', 'online-guest');
    engine.startGame();
  }

  /** Stops timers and closes overlays belonging to the previous game. */
  function teardownGame() {
    clearTimers();
    App.engine = null;
    App.revealedPlayerId = null;
    App.selectedCardId = null;
    App.selectedSuit = null;
    App.paused = false;
    App.flowLocked = false;
    App.resultShownForRound = null;
    App.gameOverShown = false;
    App.openModalKind = null;
    App.lastTurnKey = null;
    ui.hideModal();
    ui.hidePrivacyScreen();
    $('pause-overlay').hidden = true;
  }

  function clearTimers() {
    clearTimeout(App.aiTimer);
    clearTimeout(App.resultTimer);
    App.aiTimer = null;
    App.resultTimer = null;
  }

  function exitToMenu() {
    teardownGame();
    refreshMenu();
    ui.showScreen('menu');
  }

  function isGameInProgress() {
    const state = App.engine && App.engine.getPublicState();
    return !!state && state.status !== S.GAME_OVER;
  }

  /** Runs `action` immediately, or after a confirmation if a game is in progress. */
  function confirmIfPlaying(title, text, label, action) {
    if (isGameInProgress()) ui.confirmDialog(title, text, label, action);
    else action();
  }

  /* ======================================================================
   * ENGINE EVENTS -> SOUND / ANIMATION / RENDER
   * =================================================================== */

  function attachEngineEvents(engine) {
    engine.on('stateChanged', function (state) {
      if (engine !== App.engine) return;
      syncOnlineModals(state);
      render();
      scheduleFlow();
    });
    engine.on('cardPlayed', function () { HS.sound.play('card'); });
    engine.on('hiddenPlayed', function () { HS.sound.play('hidden'); });
    engine.on('roundResolved', function (result) {
      HS.sound.play(result.type === 'clean' ? 'clean' : 'collect');
    });
    engine.on('playerFinished', function (info) {
      setTimeout(function () { HS.sound.play('finished'); ui.pulseSeat(info.playerId, 'seat--celebrate'); }, 400);
    });
    engine.on('gameOver', function () {
      setTimeout(function () { HS.sound.play('gameover'); }, 700);
    });
    engine.on('invalidMove', function (info) {
      HS.sound.play('error');
      ui.showToast(info.error, 'error');
    });
  }

  /** Whose private hand may be shown right now (null = nobody's). */
  function getViewerId() {
    if (!App.engine) return null;
    if (App.mode === 'ai') return 0;           // the single human is always player 0
    if (App.mode === 'online') return HS.online.mySeat();  // each phone shows only its own hand
    return App.revealedPlayerId;               // pass & play: only after "Reveal My Hand"
  }

  /** True on the device that runs the real engine (everything except online guests). */
  function isAuthority() {
    return App.mode !== 'online' || HS.online.isHost();
  }

  function render() {
    if (!App.engine || !App.engine.getPublicState()) return;
    const publicState = App.engine.getPublicState();
    const viewerId = getViewerId();
    const privateView = viewerId !== null ? App.engine.getPrivateView(viewerId) : null;
    ui.renderGame(publicState, privateView, {
      mode: App.mode,
      viewerId: viewerId,
      selectedCardId: App.selectedCardId,
      selectedSuit: App.selectedSuit,
      bottomPlayerId: App.mode === 'online' ? viewerId : 0
    });
    if (HS.debug) HS.debug.refresh();
  }

  /**
   * Online guests don't control round flow, so their result / game-over
   * dialogs close by themselves once the host moves the game on.
   */
  function syncOnlineModals(state) {
    if (App.openModalKind === 'result' && state.status !== S.NEXT_ROUND) {
      ui.hideModal();
      App.openModalKind = null;
    }
    if (App.openModalKind === 'gameover' && state.status !== S.GAME_OVER) {
      ui.hideModal();
      App.openModalKind = null;
    }
    // A new game in the same room starts again from round 1.
    if (App.resultShownForRound !== null && state.roundNumber < App.resultShownForRound) {
      App.resultShownForRound = null;
      ui.resetRenderMemory();
    }
    if (state.status !== S.GAME_OVER) App.gameOverShown = false;
  }

  /* ======================================================================
   * FLOW: decides what happens next after each state change
   * =================================================================== */

  function scheduleFlow() {
    if (!App.engine || App.paused || App.flowLocked) return;
    clearTimeout(App.aiTimer);
    App.aiTimer = null;

    const state = App.engine.getPublicState();
    switch (state.status) {
      case S.SELECT_CARD:
      case S.SELECT_HIDDEN_SUIT:
        handleTurn(state);
        break;
      case S.NEXT_ROUND:
        scheduleRoundResult(state);
        break;
      case S.GAME_OVER:
        scheduleGameOver();
        break;
    }
  }

  function handleTurn(state) {
    const current = state.players[state.currentPlayerId];
    if (current.type === 'ai') {
      if (isAuthority()) App.aiTimer = setTimeout(runAiTurn, HS.config.AI_DELAYS[App.settings.aiSpeed] || 900);
      return;
    }
    if (App.mode === 'pass' && App.revealedPlayerId !== current.id) {
      // PRIVACY: hide every hand and ask for the device to be passed.
      App.revealedPlayerId = null;
      render();
      ui.showPrivacyScreen(current.name);
      return;
    }
    // Beep once when it becomes this device's turn.
    const turnKey = state.roundNumber + ':' + state.roundPlays.length;
    if (App.mode !== 'pass' && current.id === getViewerId() && App.lastTurnKey !== turnKey) {
      App.lastTurnKey = turnKey;
      HS.sound.play('turn');
    }
  }

  /** AI moves go through dispatch() exactly like human moves. */
  function runAiTurn() {
    App.aiTimer = null;
    if (!App.engine || App.paused || !isAuthority()) return;
    if (ui.isModalOpen()) {               // wait while rules/confirm dialogs are open
      App.aiTimer = setTimeout(runAiTurn, 400);
      return;
    }
    const state = App.engine.getPublicState();
    const current = state.players[state.currentPlayerId];
    if (!current || current.type !== 'ai') return;
    const move = HS.ai.chooseMove(state, App.engine.getPrivateView(current.id));
    App.engine.dispatch(move);
  }

  function scheduleRoundResult(state) {
    if (App.resultShownForRound === state.roundNumber || App.resultTimer) return;
    // Short pause so everybody sees the final card land before the summary.
    App.resultTimer = setTimeout(function () {
      App.resultTimer = null;
      if (!App.engine || App.paused) return;
      const latest = App.engine.getPublicState();
      if (latest.status !== S.NEXT_ROUND) return;
      App.resultShownForRound = latest.roundNumber;
      App.openModalKind = 'result';
      const onClose = function () {
        App.openModalKind = null;
        if (isAuthority()) App.engine.dispatch({ type: A.CONTINUE });
      };
      const options = isAuthority() ? {} : {
        label: 'OK',
        note: 'The next round starts when the host taps Continue.'
      };
      ui.showRoundResult(latest, buildPrivateResultExtra(), onClose, options);
    }, 1200);
  }

  /**
   * In AI and online modes the screen belongs to one player, so their private
   * information for this round (e.g. hidden cards they collected) may be shown
   * in the summary. In pass & play the summary is PUBLIC; private info appears
   * only after "Reveal My Hand".
   */
  function buildPrivateResultExtra() {
    if (App.mode === 'pass') return '';
    const view = App.engine.getPrivateView(getViewerId());
    if (!view) return '';
    const round = App.engine.getPublicState().roundNumber;
    const notes = view.unreadNotices.filter(function (n) { return n.round === round; });
    if (!notes.length) return '';
    return '<div class="notice notice--modal"><div class="notice__label">🔐 Private — only you can see this</div>' +
      notes.map(function (n) {
        const cards = n.hiddenCards.length
          ? '<div class="notice__cards">' + n.hiddenCards.map(function (c) { return ui.cardHtml(c, 'card--mini card--secret'); }).join('') + '</div>'
          : '';
        return '<div class="notice__item">' + HS.utils.escapeHtml(n.text) + cards + '</div>';
      }).join('') + '</div>';
  }

  function scheduleGameOver() {
    if (App.gameOverShown || App.resultTimer) return;
    App.resultTimer = setTimeout(function () {
      App.resultTimer = null;
      if (!App.engine) return;
      if (App.engine.getPublicState().status !== S.GAME_OVER) return;
      App.gameOverShown = true;
      App.revealedPlayerId = null;
      render();
      App.openModalKind = 'gameover';
      if (App.mode === 'online') {
        const guest = !HS.online.isHost();
        ui.renderResults(App.engine.getPublicState(),
          function () { App.openModalKind = null; if (!guest) restartGame(); },
          function () { App.openModalKind = null; HS.online.leaveRoom(); },
          { guest: guest });
        return;
      }
      ui.renderResults(App.engine.getPublicState(),
        function () { App.openModalKind = null; restartGame(); },
        function () { App.openModalKind = null; exitToMenu(); });
    }, 1400);
  }

  /* ======================================================================
   * PLAYER INPUT
   * =================================================================== */

  function currentPrivateView() {
    const viewerId = getViewerId();
    return viewerId !== null && App.engine ? App.engine.getPrivateView(viewerId) : null;
  }

  function onCardClick(cardId) {
    const view = currentPrivateView();
    if (!view || App.engine.awaitingMove) return;   // online: a move is already on its way
    if (!view.isMyTurn) { ui.showToast("It's not your turn yet.", 'info'); return; }
    if (view.mustPlayHidden) {
      ui.showToast('You cannot follow the active suit — choose a suit above.', 'info');
      return;
    }
    // Ask the engine (not the UI) whether this card is legal, so rules live in one place.
    const error = App.engine.validateMove({ type: A.PLAY_CARD, playerId: view.playerId, cardId: cardId });
    if (error) {
      HS.sound.play('error');
      ui.showToast(error, 'error');
      return;
    }
    App.selectedCardId = App.selectedCardId === cardId ? null : cardId;
    render();
  }

  function onSuitClick(suitKey) {
    const view = currentPrivateView();
    if (!view || !view.mustPlayHidden) return;
    App.selectedSuit = suitKey;
    render();
  }

  function onConfirm() {
    const view = currentPrivateView();
    if (!view || !view.isMyTurn || App.paused || App.engine.awaitingMove) return;

    const action = view.mustPlayHidden
      ? { type: A.PLAY_HIDDEN_SUIT, playerId: view.playerId, suit: App.selectedSuit }
      : { type: A.PLAY_CARD, playerId: view.playerId, cardId: App.selectedCardId };
    if (!action.suit && !action.cardId) return;

    const hiddenCount = view.mustPlayHidden
      ? view.hand.filter(function (c) { return c.suit === App.selectedSuit; }).length : 0;

    // The player has seen their private notices by the time they move.
    if (view.unreadNotices.length) App.engine.dispatch({ type: A.ACK_NOTICES, playerId: view.playerId });

    // Pass & play: hide this hand BEFORE the next state is drawn.
    const previousReveal = App.revealedPlayerId;
    if (App.mode === 'pass') App.revealedPlayerId = null;
    if (view.mustPlayHidden) App.flowLocked = true;

    const result = App.engine.dispatch(action);
    if (!result.ok) {
      App.revealedPlayerId = previousReveal;
      App.flowLocked = false;
      render();
      return;
    }
    App.selectedCardId = null;
    App.selectedSuit = null;

    if (view.mustPlayHidden) showHiddenPlayConfirmation(hiddenCount);
    else render();
  }

  /** Private acknowledgement for the player who just played hidden cards. */
  function showHiddenPlayConfirmation(count) {
    const text = '🔒 ' + count + ' card' + (count === 1 ? '' : 's') + ' secretly played.';
    const release = function () {
      App.flowLocked = false;
      render();
      scheduleFlow();
    };
    if (App.mode !== 'pass') {
      ui.showToast(text, 'secret');
      release();
      return;
    }
    ui.showModal('Secret play done', '<p class="big-text">' + text + '</p>' +
      '<p>Your hand is now hidden. The round has ended.</p>',
      [{ label: 'OK', className: 'btn--primary', onClick: release }], 'modal--small');
  }

  function onReveal() {
    const state = App.engine && App.engine.getPublicState();
    if (!state || state.currentPlayerId === null) return;
    ui.hidePrivacyScreen();
    App.revealedPlayerId = state.currentPlayerId;
    App.selectedCardId = null;
    App.selectedSuit = null;
    HS.sound.play('turn');
    render();
  }

  function onDismissNotices() {
    const viewerId = getViewerId();
    if (viewerId !== null) App.engine.dispatch({ type: A.ACK_NOTICES, playerId: viewerId });
  }

  /* ======================================================================
   * TOP-BAR CONTROLS
   * =================================================================== */

  function restartGame() {
    if (App.mode === 'online') HS.online.restartGame();
    else startGame(App.lastStartOptions || {});
  }

  function togglePause() {
    if (!App.engine) return;
    App.paused = !App.paused;
    $('pause-overlay').hidden = !App.paused;
    $('btn-pause').classList.toggle('is-active', App.paused);
    if (App.paused) clearTimers();
    else scheduleFlow();
  }

  function setSound(on) {
    App.settings.soundOn = !!on;
    HS.sound.setEnabled(App.settings.soundOn);
    saveSettings();
    const btn = $('btn-sound');
    btn.innerHTML = (on ? '🔊' : '🔇') + '<span>Sound</span>';
    btn.classList.toggle('is-active', !on);
    $('sound-toggle-menu').checked = !!on;
  }

  function toggleLog() {
    if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.toggle('log-open');
    else document.body.classList.toggle('log-collapsed');
  }

  function bindControls() {
    $('btn-new').addEventListener('click', function () {
      if (App.mode === 'online') HS.online.confirmLeave();
      else confirmIfPlaying('Start a new game?', 'The current game will be lost.', 'New Game', exitToMenu);
    });
    $('btn-restart').addEventListener('click', function () {
      confirmIfPlaying('Restart this game?', 'Cards will be re-dealt with the same players.', 'Restart', restartGame);
    });
    $('btn-exit').addEventListener('click', function () {
      if (App.mode === 'online') HS.online.confirmLeave();
      else confirmIfPlaying('Exit to menu?', 'The current game will be lost.', 'Exit', exitToMenu);
    });
    $('btn-pause').addEventListener('click', togglePause);
    $('btn-resume').addEventListener('click', togglePause);
    $('btn-sound').addEventListener('click', function () { setSound(!App.settings.soundOn); });
    $('btn-rules').addEventListener('click', ui.showRules);
    $('btn-log').addEventListener('click', toggleLog);
    $('btn-log-close').addEventListener('click', toggleLog);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && ui.isModalOpen() && !document.querySelector('.modal--result, .modal--gameover')) {
        ui.hideModal();
        if (App.flowLocked) { App.flowLocked = false; render(); scheduleFlow(); }
      }
    });
  }

  /* ======================================================================
   * STARTUP
   * =================================================================== */

  function init() {
    loadSettings();
    buildMenu();
    bindControls();
    setSound(App.settings.soundOn);
    ui.bindHandlers({
      onCardClick: onCardClick,
      onSuitClick: onSuitClick,
      onConfirm: onConfirm,
      onReveal: onReveal,
      onDismissNotices: onDismissNotices
    });
    if (HS.config.DEBUG_MODE && HS.debug) HS.debug.init(App, { startGame: startGame, render: render });

    HS.online.init({
      app: App,
      attachEngineEvents: attachEngineEvents,
      teardownGame: teardownGame,
      exitToMenu: exitToMenu,
      render: render,
      saveSettings: saveSettings
    });
  }

  HS.app = App;
  document.addEventListener('DOMContentLoaded', init);
})(window.HiddenSuit);
