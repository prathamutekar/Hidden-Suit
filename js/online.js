/*
 * online.js
 * ---------------------------------------------------------------------------
 * Controller for ONLINE ROOMS (each player on their own phone).
 *
 * Flow:
 *   Menu ──Create Room──► Lobby (host)   ──Start──► host runs the real GameEngine
 *   Menu ──Join Room────► Lobby (guest)  ─────────► guest shows a RemoteEngine
 *
 * The host phone is authoritative (see network.js). Everything else in the
 * game screen (rendering, card clicks, modals) is shared with the local
 * modes through main.js, because a RemoteEngine looks like a GameEngine.
 *
 * Firebase pushes changes to every phone instantly, so there is no polling:
 * each phone just listens to the room.
 */
'use strict';

(function (HS) {
  const ui = HS.ui;
  const $ = function (id) { return document.getElementById(id); };

  let api = null;     // helpers handed over by main.js
  let online = null;  // current room session (null when not in a room)
  let flags = { connectionLost: false, hostOffline: false };

  /* ======================================================================
   * SET-UP
   * =================================================================== */

  function init(mainApi) {
    api = mainApi;
    bindMenu();
    bindLobby();
    prefillFromUrl();
    tryResume();
  }

  function mySeat() {
    return online ? online.session.seat : null;
  }

  function isHost() {
    return !!online && online.isHost;
  }

  function bindMenu() {
    const nameInput = $('online-name');
    nameInput.value = api.app.settings.onlineName || '';
    nameInput.addEventListener('input', function () {
      api.app.settings.onlineName = nameInput.value.slice(0, 16);
      api.saveSettings();
    });
    const codeInput = $('join-code');
    codeInput.addEventListener('input', function () {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
    codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });
    $('btn-create-room').addEventListener('click', createRoom);
    $('btn-join-room').addEventListener('click', joinRoom);

    if (!HS.net.isAvailable()) {
      $('online-note').textContent = window.firebase
        ? 'Online rooms need the game to be opened from a web address (e.g. GitHub Pages), not as a file.'
        : 'Online rooms need an internet connection (Firebase could not be loaded).';
      $('online-note').classList.add('online-note--warn');
    }
  }

  function bindLobby() {
    $('btn-add-bot').addEventListener('click', function () {
      if (!isHost() || !online.lobby) return;
      const bots = online.lobby.players.filter(function (p) { return p.type === 'ai'; }).length;
      HS.net.addBot(online.session, bots).catch(showError);
    });
    $('btn-start-online').addEventListener('click', startOnlineGame);
    $('btn-leave-room').addEventListener('click', confirmLeave);
    $('btn-copy-link').addEventListener('click', copyInviteLink);
    $('lobby-players').addEventListener('click', function (event) {
      const btn = event.target.closest('[data-kick]');
      if (!btn || !isHost() || !online.lobby) return;
      const player = online.lobby.players[Number(btn.dataset.kick)];
      if (player) HS.net.removeLobbyPlayer(online.session, player).catch(showError);
    });
  }

  function showError(err) {
    ui.showToast(err.message, 'error');
  }

  /** Opening an invite link (?room=ABCD) pre-selects Online mode and fills the code. */
  function prefillFromUrl() {
    const code = new URLSearchParams(window.location.search).get('room');
    if (!code || !HS.net.isAvailable()) return;
    const onlineButton = document.querySelector('.mode-btn[data-mode="online"]');
    if (onlineButton) onlineButton.click();
    $('join-code').value = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  }

  /* ======================================================================
   * CREATE / JOIN / LEAVE
   * =================================================================== */

  function readName() {
    const name = $('online-name').value.trim().slice(0, 16);
    if (!name) {
      ui.showToast('Type your name first.', 'error');
      $('online-name').focus();
    }
    return name;
  }

  function setBusy(busy) {
    $('btn-create-room').disabled = busy;
    $('btn-join-room').disabled = busy;
  }

  async function createRoom() {
    const name = readName();
    if (!name) return;
    setBusy(true);
    try {
      startSession(await HS.net.createRoom(name));
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      ui.showToast('Enter the 4-letter room code.', 'error');
      $('join-code').focus();
      return;
    }
    const name = readName();
    if (!name) return;
    setBusy(true);
    try {
      startSession(await HS.net.joinRoom(code, name));
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  function newOnlineState(session) {
    return {
      session: session,
      isHost: !!session.isHost,
      lobby: null,
      stopWatching: null,  // stops the room listener
      stopPrivate: null,   // guest only: stops the private-view listener
      hostSession: null,   // host only
      remote: null         // guest only
    };
  }

  function startSession(session) {
    HS.net.session.save(session);
    online = newOnlineState(session);
    showLobby();
    watch();
  }

  function confirmLeave() {
    const text = isHost()
      ? 'You are the host — leaving closes the room for everyone.'
      : 'You will leave this online game.';
    ui.confirmDialog('Leave the room?', text, 'Leave', leaveRoom);
  }

  function leaveRoom() {
    if (online) {
      const status = online.lobby ? online.lobby.status : 'lobby';
      HS.net.leaveRoom(online.session, status).catch(function () {});
    }
    cleanup();
    api.exitToMenu();
  }

  /** The room vanished, was closed, or we were removed from it. */
  function roomGone(message) {
    ui.showToast(message, 'error');
    cleanup();
    api.exitToMenu();
  }

  function cleanup() {
    if (online) {
      if (online.stopWatching) online.stopWatching();
      if (online.stopPrivate) online.stopPrivate();
      if (online.hostSession) online.hostSession.stop();
    }
    online = null;
    HS.net.session.clear();
    document.body.classList.remove('mode-online', 'online-guest');
    flags = { connectionLost: false, hostOffline: false };
    updateBanner();
  }

  /* ======================================================================
   * LOBBY
   * =================================================================== */

  function inviteLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', online.session.code);
    return url.toString();
  }

  function copyInviteLink() {
    const link = $('lobby-link');
    const done = function () { ui.showToast('Invite link copied!', 'info'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link.value).then(done, function () { link.select(); });
    } else {
      link.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* user can copy manually */ }
    }
  }

  function showLobby() {
    ui.showScreen('lobby');
    $('lobby-code').textContent = online.session.code;
    $('lobby-link').value = inviteLink();
    renderLobby();
  }

  function renderLobby() {
    if (!online) return;
    const lobby = online.lobby;
    const players = lobby ? lobby.players : [];
    const escape = HS.utils.escapeHtml;

    $('lobby-count').textContent = '(' + players.length + '/' + HS.config.MAX_PLAYERS + ')';
    $('lobby-players').innerHTML = players.map(function (p) {
      const me = p.uid && p.uid === online.session.uid;
      const tags = [];
      if (p.seat === 0) tags.push('Host');
      if (p.type === 'ai') tags.push('AI');
      if (me) tags.push('You');
      const kick = isHost() && p.seat > 0 && lobby.status === 'lobby'
        ? '<button type="button" class="lobby-player__kick" data-kick="' + p.seat + '" title="Remove">✕</button>' : '';
      return '<li class="lobby-player' + (me ? ' lobby-player--me' : '') + '">' +
        '<span class="lobby-player__dot' + (p.online ? '' : ' lobby-player__dot--off') + '"></span>' +
        '<span class="lobby-player__name">' + (p.type === 'ai' ? '🤖 ' : '') + escape(p.name) + '</span>' +
        '<span class="lobby-player__tag">' + tags.join(' · ') + '</span>' + kick + '</li>';
    }).join('');

    $('lobby-host-actions').hidden = !isHost();
    $('btn-start-online').disabled = players.length < HS.config.MIN_PLAYERS;
    $('btn-add-bot').disabled = players.length >= HS.config.MAX_PLAYERS;

    let status;
    if (!lobby) status = 'Connecting…';
    else if (lobby.status === 'playing') status = 'The game is starting…';
    else if (isHost()) status = players.length < 2 ? 'Waiting for players to join…' : 'Tap Start when everyone has joined.';
    else status = 'Waiting for ' + escape(players[0] ? players[0].name : 'the host') + ' to start the game…';
    $('lobby-status').innerHTML = status;
  }

  /* ======================================================================
   * LISTENING TO THE ROOM (lobby for everyone, game start for guests)
   * =================================================================== */

  function watch() {
    const current = online;
    current.stopWatching = HS.net.watchRoom(current.session, {
      onLobby: function (lobby) { if (online === current) handleLobby(lobby); },
      onGone: function (message) { if (online === current) roomGone(message); },
      onConnection: function (connected) { if (online === current) setConnectionLost(!connected); }
    });
  }

  function handleLobby(lobby) {
    online.lobby = lobby;
    const me = lobby.players.find(function (p) { return p.uid === online.session.uid; });
    if (me && me.seat !== online.session.seat) {
      online.session.seat = me.seat;      // seats shift when someone leaves the lobby
      HS.net.session.save(online.session);
    }
    if ($('screen-lobby').classList.contains('screen--active')) renderLobby();

    if (!online.isHost) {
      setHostOffline(lobby.status === 'playing' && !lobby.hostOnline);
      if (lobby.status === 'playing' && !online.stopPrivate) watchGuestGame();
    }
  }

  /* ======================================================================
   * GUEST: show the host's game
   * =================================================================== */

  function watchGuestGame() {
    const current = online;
    current.stopPrivate = HS.net.watchPrivate(current.session, function (bundle) {
      if (online !== current) return;
      current.session.seat = bundle.seat;
      receiveGameState(bundle.publicState, bundle.privateView);
    });
  }

  function receiveGameState(publicState, privateView) {
    if (!online.remote) {
      api.teardownGame();
      online.remote = new HS.net.RemoteEngine(online.session);
      api.attachEngineEvents(online.remote);
      api.app.engine = online.remote;
      api.app.mode = 'online';
      enterGameScreen();
    }
    online.remote.applyUpdate(publicState, privateView);
  }

  function enterGameScreen() {
    ui.resetRenderMemory();
    ui.showScreen('game');
    document.body.classList.remove('mode-pass', 'mode-ai');
    document.body.classList.add('mode-online');
    document.body.classList.toggle('online-guest', !online.isHost);
  }

  /* ======================================================================
   * HOST: run the real engine
   * =================================================================== */

  async function startOnlineGame() {
    if (!isHost() || !online.lobby) return;
    $('btn-start-online').disabled = true;
    const seats = online.lobby.players.map(function (p) {
      return { uid: p.uid || '', name: p.name, type: p.type };
    });
    try {
      await HS.net.startRoom(online.session, seats);
      beginHostGame(seats, null);
    } catch (err) {
      showError(err);
      renderLobby();
    }
  }

  /** Creates (or restores from a snapshot) the authoritative engine on the host phone. */
  function beginHostGame(seats, snapshot) {
    api.teardownGame();
    const engine = new HS.GameEngine();
    if (snapshot) engine.importState(snapshot.engine);
    else engine.initializeGame({ players: seats.map(function (p) { return { name: p.name, type: p.type }; }) });

    api.attachEngineEvents(engine);
    api.app.engine = engine;
    api.app.mode = 'online';

    const hostSession = new HS.net.HostSession(online.session, engine, seats);
    let lastShown = 0;
    hostSession.onError = function (err) {
      if (Date.now() - lastShown < 10000) return;  // publish retries every 1.5 s; don't spam
      lastShown = Date.now();
      ui.showToast(err.message, 'error');
    };
    online.hostSession = hostSession;
    enterGameScreen();
    hostSession.start();

    if (snapshot) engine.emitStateChange();  // redraw + republish the restored game
    else engine.startGame();
  }

  /** "Play Again" / "Restart" for the host: same players, fresh deal. */
  function restartGame() {
    if (!isHost() || !online.hostSession) return;
    const players = api.app.engine.getPublicState().players;
    api.teardownGame();
    const engine = new HS.GameEngine();
    engine.initializeGame({ players: players.map(function (p) { return { name: p.name, type: p.type }; }) });
    api.attachEngineEvents(engine);
    api.app.engine = engine;
    online.hostSession.attach(engine);
    ui.resetRenderMemory();
    engine.startGame();
  }

  /* ======================================================================
   * RESUME after a refresh or when a phone reopens the tab
   * =================================================================== */

  async function tryResume() {
    const saved = HS.net.session.load();
    if (!saved || !HS.net.isAvailable()) return;
    let meta;
    try {
      const uid = await HS.net.connect();
      if (uid !== saved.uid) { HS.net.session.clear(); return; }
      meta = await HS.net.readMeta(saved.code);
    } catch (err) {
      ui.showToast('Could not reconnect to room ' + saved.code + '.', 'error');
      return;
    }
    if (!meta) { HS.net.session.clear(); return; }

    saved.isHost = meta.hostUid === saved.uid;
    online = newOnlineState(saved);
    ui.showToast('Reconnected to room ' + saved.code + '.', 'info');

    if (meta.status === 'playing' && online.isHost) {
      try {
        const snapshot = await HS.net.readHostSnapshot(saved);
        if (!snapshot) throw new Error('No saved game found for this room.');
        beginHostGame(meta.seats, snapshot);
      } catch (err) {
        roomGone(err.message);
        return;
      }
    } else {
      showLobby();
    }
    watch();   // guests switch to the game as soon as the room reports "playing"
  }

  /* ======================================================================
   * CONNECTION BANNER
   * =================================================================== */

  function setConnectionLost(value) {
    if (flags.connectionLost === value) return;
    flags.connectionLost = value;
    updateBanner();
  }

  function setHostOffline(value) {
    if (flags.hostOffline === value) return;
    flags.hostOffline = value;
    updateBanner();
  }

  function updateBanner() {
    const banner = $('connection-banner');
    if (flags.connectionLost) banner.textContent = '📡 Connection lost — reconnecting…';
    else if (flags.hostOffline) banner.textContent = '⏳ The host is offline — waiting for them to come back…';
    banner.hidden = !(flags.connectionLost || flags.hostOffline);
  }

  HS.online = {
    init: init,
    mySeat: mySeat,
    isHost: isHost,
    confirmLeave: confirmLeave,
    leaveRoom: leaveRoom,
    restartGame: restartGame
  };
})(window.HiddenSuit);
