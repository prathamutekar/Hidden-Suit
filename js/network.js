/*
 * network.js
 * ---------------------------------------------------------------------------
 * Online rooms over Firebase Realtime Database (no server of our own).
 *
 *   Guest phone ──action──► rooms/CODE/inbox ──► HOST phone (runs the real GameEngine)
 *        ▲                                          │ validate + apply
 *        └── rooms/CODE/private/MY_UID ◄────────────┘ public state + MY private view
 *
 * Database layout (see firebase-rules.json for who may read/write what):
 *   roomIndex/CODE            creation time (lets anyone delete rooms older than a day)
 *   rooms/CODE/meta           hostUid, status (lobby | playing), created, bots, seats
 *   rooms/CODE/members/UID    name, joinedAt, online     (one per human player)
 *   rooms/CODE/inbox/ID       uid, action                (guest moves, read only by host)
 *   rooms/CODE/private/UID    JSON {publicState, privateView, seat}  (read only by UID)
 *   rooms/CODE/hostData       JSON engine snapshot       (host only, for resume)
 *
 * Every player signs in anonymously, so each phone has a Firebase "uid".
 * The security rules use it to make sure a phone can only read ITS OWN
 * private view and can only send moves as itself.
 *
 * Game states are stored as JSON strings because Firebase silently drops
 * empty arrays and null values, which the engine's state is full of.
 *
 * Two classes:
 *   RemoteEngine  used on GUEST phones. Looks like a GameEngine to main.js
 *                 (getPublicState, getPrivateView, dispatch, events) but only
 *                 holds the public state + this player's own private view.
 *   HostSession   used on the HOST phone. Feeds guest moves into the real
 *                 engine and publishes one private view per player.
 */
'use strict';

(function (HS) {
  const A = HS.ACTIONS;
  const S = HS.STATES;
  const { EventEmitter, getSuitInfo } = HS.utils;

  const SESSION_KEY = 'hiddenSuit.online.v2';
  const GUEST_ACTIONS = [A.PLAY_CARD, A.PLAY_HIDDEN_SUIT, A.ACK_NOTICES];
  const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid confusion
  const BOT_NAMES = ['Ada', 'Blaze', 'Cipher', 'Dex', 'Echo', 'Flint', 'Gizmo', 'Hex', 'Ivy'];

  const sleep = (ms) => new Promise(function (resolve) { setTimeout(resolve, ms); });
  const pack = (value) => JSON.stringify(value);
  const unpack = (text) => (typeof text === 'string' ? JSON.parse(text) : null);

  let db = null;
  let connecting = null;

  /** Online play needs the Firebase scripts (loaded from the internet) and a web address. */
  function isAvailable() {
    const webPage = window.location.protocol === 'http:' || window.location.protocol === 'https:';
    return webPage && !!window.firebase && !!(HS.firebaseConfig && HS.firebaseConfig.databaseURL);
  }

  /** Turns Firebase error codes into messages a player can understand. */
  function friendlyError(err) {
    const code = String((err && (err.code || err.message)) || '').toLowerCase();
    let message = (err && err.message) || 'Something went wrong.';
    if (code.indexOf('operation-not-allowed') !== -1 || code.indexOf('admin-restricted') !== -1) {
      message = 'Anonymous sign-in is not enabled in Firebase (Authentication → Sign-in method).';
    } else if (code.indexOf('permission') !== -1) {
      message = 'Firebase refused access. Check the Realtime Database rules.';
    } else if (code.indexOf('network') !== -1) {
      message = 'Connection problem. Check your internet.';
    }
    const error = new Error(message);
    error.code = err && err.code;
    return error;
  }

  /** Resolves with the first auth state Firebase restores (signed-in user or null). */
  function firstAuthState(auth) {
    return new Promise(function (resolve) {
      const off = auth.onAuthStateChanged(function (user) { off(); resolve(user); });
    });
  }

  /**
   * Starts Firebase and signs in anonymously (once). Returns this phone's uid.
   * SESSION persistence keeps the uid per browser tab, so a refresh keeps the
   * same player, and several test tabs on one computer are different players.
   */
  function connect() {
    if (!connecting) {
      connecting = (async function () {
        if (!firebase.apps.length) firebase.initializeApp(HS.firebaseConfig);
        const auth = firebase.auth();
        await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
        let user = auth.currentUser || await firstAuthState(auth);
        if (!user) user = (await auth.signInAnonymously()).user;
        db = firebase.database();
        return user.uid;
      })().catch(function (err) {
        connecting = null;
        throw friendlyError(err);
      });
    }
    return connecting;
  }

  function roomRef(code, path) {
    return db.ref('rooms/' + code + (path ? '/' + path : ''));
  }

  /** Runs a Firebase call and converts its errors to friendly ones. */
  async function guard(promise) {
    try {
      return await promise;
    } catch (err) {
      throw friendlyError(err);
    }
  }

  function randomCode() {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    return code;
  }

  /** Deletes a few rooms older than a day (Firebase has no server to do it for us). */
  async function deleteOldRooms() {
    const snap = await db.ref('roomIndex').orderByValue().endAt(Date.now() - ROOM_MAX_AGE_MS).limitToFirst(10).once('value');
    const codes = Object.keys(snap.val() || {});
    for (const code of codes) {
      await roomRef(code).remove();
      await db.ref('roomIndex/' + code).remove();
    }
  }

  /* ------------------------------------------------------------------------
   * Session (remembered so a refreshed phone can rejoin).
   * sessionStorage is per tab, matching Firebase's SESSION sign-in.
   * --------------------------------------------------------------------- */
  const sessionStore = {
    save: function (session) {
      try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (err) { /* ignore */ }
    },
    load: function () {
      try { return JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (err) { return null; }
    },
    clear: function () {
      try { window.sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* ignore */ }
    }
  };

  /* ========================================================================
   * ROOMS: create / join / leave / lobby
   * ===================================================================== */

  /** Creates a room with a free 4-letter code. The creator is the host (seat 0). */
  async function createRoom(name) {
    const uid = await connect();
    deleteOldRooms().catch(function () { /* cleanup is best-effort */ });

    for (let attempt = 0; attempt < 20; attempt++) {
      const code = randomCode();
      const created = Date.now();
      // A transaction only writes if the code is still unused.
      const result = await guard(roomRef(code, 'meta').transaction(function (current) {
        if (current !== null) return undefined;
        return { hostUid: uid, status: 'lobby', created: created };
      }));
      if (!result.committed) continue;
      await guard(roomRef(code, 'members/' + uid).set({ name: name, joinedAt: created, online: true }));
      await guard(db.ref('roomIndex/' + code).set(created));
      return { code: code, uid: uid, isHost: true, seat: 0, name: name };
    }
    throw new Error('Could not create a room code, try again.');
  }

  /** Joins a room that is still in its lobby (or rejoins one you are already in). */
  async function joinRoom(code, name) {
    const uid = await connect();
    const meta = (await guard(roomRef(code, 'meta').once('value'))).val();
    if (!meta) throw new Error('Room not found. Check the code.');

    const members = (await guard(roomRef(code, 'members').once('value'))).val() || {};
    if (members[uid]) return { code: code, uid: uid, isHost: meta.hostUid === uid, seat: null, name: name };
    if (meta.status !== 'lobby') throw new Error('That game has already started.');

    const count = Object.keys(members).length + Object.keys(meta.bots || {}).length;
    if (count >= HS.config.MAX_PLAYERS) throw new Error('Room is full (' + HS.config.MAX_PLAYERS + ' players).');

    await guard(roomRef(code, 'members/' + uid).set({
      name: name,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
      online: true
    }));
    return { code: code, uid: uid, isHost: false, seat: null, name: name };
  }

  /** Host leaving deletes the room for everyone; a guest leaves the lobby (or goes offline mid-game). */
  async function leaveRoom(session, status) {
    await connect();
    const memberRef = roomRef(session.code, 'members/' + session.uid);
    await memberRef.child('online').onDisconnect().cancel();
    if (session.isHost) {
      await db.ref('roomIndex/' + session.code).remove();
      await roomRef(session.code).remove();
    } else if (status === 'lobby') {
      await memberRef.remove();
    } else {
      await memberRef.child('online').set(false);
    }
  }

  function addBot(session, botCount) {
    return guard(roomRef(session.code, 'meta/bots').push({
      name: BOT_NAMES[botCount % BOT_NAMES.length],
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    }));
  }

  function removeLobbyPlayer(session, player) {
    const path = player.type === 'ai' ? 'meta/bots/' + player.key : 'members/' + player.key;
    return guard(roomRef(session.code, path).remove());
  }

  /** Locks the seat order and switches the room to "playing". */
  function startRoom(session, seats) {
    return guard(roomRef(session.code, 'meta').update({ status: 'playing', seats: seats }));
  }

  function readHostSnapshot(session) {
    return guard(roomRef(session.code, 'hostData').once('value')).then(function (snap) { return unpack(snap.val()); });
  }

  function readMeta(code) {
    return guard(roomRef(code, 'meta').once('value')).then(function (snap) { return snap.val(); });
  }

  /**
   * Turns raw meta + members into the list shown in the lobby.
   * In the lobby the order is: host, then everyone by join time.
   * Once playing, the order is the locked `meta.seats`.
   */
  function buildLobby(code, meta, members) {
    let players;
    if (meta.status === 'playing' && meta.seats) {
      players = meta.seats.map(function (seat, index) {
        const member = seat.uid ? members[seat.uid] : null;
        return {
          seat: index, key: seat.uid || 'bot' + index, uid: seat.uid || null, name: seat.name, type: seat.type,
          online: seat.type === 'ai' || !!(member && member.online)
        };
      });
    } else {
      players = [];
      Object.keys(members).forEach(function (uid) {
        const m = members[uid];
        if (!m || !m.name) return; // ignore half-written entries
        players.push({ key: uid, uid: uid, name: m.name, type: 'human', joinedAt: m.joinedAt || 0, online: !!m.online });
      });
      Object.keys(meta.bots || {}).forEach(function (id) {
        const b = meta.bots[id];
        players.push({ key: id, uid: null, name: b.name, type: 'ai', joinedAt: b.joinedAt || 0, online: true });
      });
      players.sort(function (a, b) {
        if (a.uid === meta.hostUid) return -1;
        if (b.uid === meta.hostUid) return 1;
        return a.joinedAt - b.joinedAt;
      });
      players.forEach(function (p, index) { p.seat = index; });
    }
    const host = members[meta.hostUid];
    return { code: code, status: meta.status, hostUid: meta.hostUid, players: players, hostOnline: !!(host && host.online) };
  }

  /**
   * Watches a room for everyone (host and guests):
   *   handlers.onLobby(lobby)      whenever players / status change
   *   handlers.onGone(message)     room deleted, or you were removed
   *   handlers.onConnection(bool)  internet connection lost / back
   * Also keeps members/UID/online up to date (Firebase flips it to false
   * by itself when this phone disconnects). Returns a stop function.
   */
  function watchRoom(session, handlers) {
    let meta;
    let members;
    let gone = false;
    let everConnected = false;
    const metaRef = roomRef(session.code, 'meta');
    const membersRef = roomRef(session.code, 'members');
    const onlineRef = roomRef(session.code, 'members/' + session.uid + '/online');
    const connectedRef = db.ref('.info/connected');

    function fail(message) {
      if (gone) return;
      gone = true;
      handlers.onGone(message);
    }

    function update() {
      if (gone || meta === undefined || members === undefined) return;
      if (!meta) return fail('The host closed the room.');
      const lobby = buildLobby(session.code, meta, members || {});
      const inRoom = lobby.players.some(function (p) { return p.uid === session.uid; });
      if (!inRoom) return fail(meta.status === 'lobby' ? 'You were removed from the room.' : 'That game has already started.');
      handlers.onLobby(lobby);
    }

    const onMeta = metaRef.on('value', function (snap) { meta = snap.val(); update(); },
      function () { fail('The room is no longer available.'); });
    const onMembers = membersRef.on('value', function (snap) { members = snap.val() || {}; update(); },
      function () { fail('The room is no longer available.'); });
    const onConnected = connectedRef.on('value', function (snap) {
      const connected = snap.val() === true;
      if (connected) {
        everConnected = true;
        onlineRef.onDisconnect().set(false)
          .then(function () { return onlineRef.set(true); })
          .catch(function () { /* removed from the room: nothing to mark */ });
      }
      if (everConnected) handlers.onConnection(connected);
    });

    return function stop() {
      gone = true;
      metaRef.off('value', onMeta);
      membersRef.off('value', onMembers);
      connectedRef.off('value', onConnected);
      // Otherwise a phone that was removed would re-create its entry when it disconnects.
      onlineRef.onDisconnect().cancel().catch(function () {});
    };
  }

  /** Guest: listens to MY private bundle {publicState, privateView, seat}. Returns a stop function. */
  function watchPrivate(session, onBundle) {
    const ref = roomRef(session.code, 'private/' + session.uid);
    const handler = ref.on('value', function (snap) {
      const bundle = unpack(snap.val());
      if (bundle) onBundle(bundle);
    });
    return function stop() { ref.off('value', handler); };
  }

  /* ========================================================================
   * GUEST SIDE
   * ===================================================================== */
  class RemoteEngine extends EventEmitter {
    constructor(session) {
      super();
      this.session = session;
      this.publicState = null;
      this.privateView = null;
      this.lastErrorId = null;
      this.awaitingMove = false;
    }

    getPublicState() {
      return this.publicState;
    }

    getPrivateView(playerId) {
      return playerId === this.session.seat ? this.privateView : null;
    }

    /**
     * Quick local check for instant feedback. The HOST engine re-validates
     * every action, so this can never let an illegal move through.
     */
    validateMove(action) {
      const view = this.privateView;
      const state = this.publicState;
      if (!view || !state) return 'Not connected yet.';
      if (action.type === A.ACK_NOTICES) return null;
      if (this.awaitingMove) return 'Sending your move…';
      if (!view.isMyTurn) return "It's not your turn.";

      if (action.type === A.PLAY_CARD) {
        if (view.mustPlayHidden) return 'You have no ' + getSuitInfo(state.activeSuit).name + '. Choose a suit to play secretly.';
        if (!view.hand.some(function (c) { return c.id === action.cardId; })) return 'That card is not in your hand.';
        if (view.legalCardIds.indexOf(action.cardId) === -1) {
          const suit = state.activeSuit || view.forcedLeadSuit;
          return 'You must follow ' + getSuitInfo(suit).name + '.';
        }
        return null;
      }
      if (action.type === A.PLAY_HIDDEN_SUIT) {
        if (!view.mustPlayHidden) return 'You can follow the active suit, so you must play one card of it.';
        if (!view.hiddenSuitOptions.some(function (o) { return o.suit === action.suit; })) return 'You do not have that suit.';
        return null;
      }
      return 'That action is not allowed.';
    }

    dispatch(action) {
      if (GUEST_ACTIONS.indexOf(action.type) === -1) return { ok: false, error: 'Only the host can do that.' };
      const error = this.validateMove(action);
      if (error) {
        this.emit('invalidMove', { action: action, error: error });
        return { ok: false, error: error };
      }
      if (action.type !== A.ACK_NOTICES) this.awaitingMove = true;
      guard(roomRef(this.session.code, 'inbox').push({ uid: this.session.uid, action: pack(action) }))
        .catch((err) => {
          this.awaitingMove = false;
          this.emit('invalidMove', { action: action, error: err.message });
        });
      return { ok: true };
    }

    /** Called whenever the host publishes a newer state for this player. */
    applyUpdate(publicState, privateView) {
      const previous = this.publicState;
      this.publicState = publicState;
      this.privateView = privateView;
      this.awaitingMove = false;
      emitDerivedEvents(this, previous, publicState);

      // Rejected moves come back as a numbered error; show each one once.
      const lastError = privateView && privateView.lastError;
      const errorId = lastError ? lastError.id : 0;
      if (lastError && this.lastErrorId !== null && errorId !== this.lastErrorId) {
        this.emit('invalidMove', { action: null, error: lastError.text });
      }
      this.lastErrorId = errorId;
      this.emit('stateChanged', publicState);
    }
  }

  /** Recreates the engine's sound/animation events by comparing two public states. */
  function emitDerivedEvents(emitter, prev, next) {
    if (!prev) return;
    if (prev.roundNumber === next.roundNumber) {
      next.roundPlays.slice(prev.roundPlays.length).forEach(function (play) {
        if (play.kind === 'visible') emitter.emit('cardPlayed', { playerId: play.playerId, card: play.card });
        else emitter.emit('hiddenPlayed', { playerId: play.playerId });
      });
    }
    const resolvedNow = next.lastRoundResult &&
      (!prev.lastRoundResult || prev.roundNumber !== next.roundNumber || prev.status !== next.status) &&
      (next.status === S.NEXT_ROUND || next.status === S.GAME_OVER);
    if (resolvedNow) emitter.emit('roundResolved', next.lastRoundResult);
    next.finishedPlayers.slice(prev.finishedPlayers.length).forEach(function (id) {
      emitter.emit('playerFinished', { playerId: id, position: next.players[id].finishPosition });
    });
    if (next.status === S.GAME_OVER && prev.status !== S.GAME_OVER) {
      emitter.emit('gameOver', { results: next.results });
    }
  }

  /* ========================================================================
   * HOST SIDE
   * ===================================================================== */
  class HostSession {
    /**
     * @param session  the host's room session
     * @param engine   the authoritative GameEngine
     * @param seats    locked seat list [{uid, name, type}] (index = playerId)
     */
    constructor(session, engine, seats) {
      this.session = session;
      this.seats = seats;
      this.seatErrors = {};
      this.errorCounter = 0;
      this.running = false;
      this.publishing = false;
      this.publishQueued = false;
      this.processedIds = {};     // inbox ids already applied to the engine
      this.unpublishedIds = [];   // applied, but not yet removed from the inbox
      this.unsubscribers = [];
      this.inboxRef = null;
      this.onError = null;        // callback(error)
      this.attach(engine);
    }

    /** Points the session at an engine (a new one after "Play Again"). */
    attach(engine) {
      this.unsubscribers.forEach(function (off) { off(); });
      this.engine = engine;
      this.seatErrors = {};
      this.unsubscribers = [
        engine.on('stateChanged', () => this.requestPublish()),
        engine.on('invalidMove', (info) => {
          const seat = info.action ? info.action.playerId : null;
          if (seat !== null && seat !== undefined && seat !== this.session.seat) {
            this.errorCounter += 1;
            this.seatErrors[seat] = { id: this.errorCounter, text: info.error };
          }
        })
      ];
    }

    /** Starts listening for guest moves (existing unprocessed ones arrive first). */
    start() {
      if (this.running) return;
      this.running = true;
      this.inboxRef = roomRef(this.session.code, 'inbox');
      this.inboxHandler = this.inboxRef.on('child_added',
        (snap) => this.handleInboxItem(snap.key, snap.val()),
        (err) => { if (this.onError) this.onError(friendlyError(err)); });
    }

    stop() {
      this.running = false;
      if (this.inboxRef) this.inboxRef.off('child_added', this.inboxHandler);
      this.unsubscribers.forEach(function (off) { off(); });
      this.unsubscribers = [];
    }

    handleInboxItem(id, item) {
      if (!this.running || this.processedIds[id]) return;
      this.processedIds[id] = true;
      this.unpublishedIds.push(id);

      // The rules guarantee item.uid is the real sender; map it to their seat.
      const seat = this.seats.findIndex(function (s) { return s.uid && s.uid === item.uid; });
      let action = null;
      try { action = unpack(item.action); } catch (err) { /* ignore garbage */ }
      if (seat > 0 && action && GUEST_ACTIONS.indexOf(action.type) !== -1) {
        this.engine.dispatch(Object.assign({}, action, { playerId: seat }));
      }
      this.requestPublish(); // also delivers error messages and clears the inbox item
    }

    /** Publishes at most one update at a time; extra changes are merged. */
    requestPublish() {
      if (!this.running) return;
      if (this.publishing) { this.publishQueued = true; return; }
      this.publishing = true;
      this.publish().finally(() => {
        this.publishing = false;
        if (this.publishQueued) {
          this.publishQueued = false;
          this.requestPublish();
        }
      });
    }

    /**
     * One multi-path write: each human guest's private bundle, the resume
     * snapshot, and removal of the inbox items just applied. Because it is a
     * single write, a host refresh never loses or repeats a move.
     */
    async publish() {
      const engine = this.engine;
      const publicState = engine.getPublicState();
      const updates = {};
      this.seats.forEach((seat, index) => {
        if (seat.type !== 'human' || !seat.uid || index === this.session.seat) return;
        const view = engine.getPrivateView(index);
        view.lastError = this.seatErrors[index] || null;
        updates['private/' + seat.uid] = pack({ publicState: publicState, privateView: view, seat: index });
      });
      updates.hostData = pack({ engine: engine.exportState() });
      const clearing = this.unpublishedIds.slice();
      clearing.forEach(function (id) { updates['inbox/' + id] = null; });

      try {
        await roomRef(this.session.code).update(updates);
        this.unpublishedIds = this.unpublishedIds.filter(function (id) { return clearing.indexOf(id) === -1; });
      } catch (err) {
        if (this.onError) this.onError(friendlyError(err));
        await sleep(1500);
        this.publishQueued = true;
      }
    }
  }

  HS.net = {
    isAvailable: isAvailable,
    connect: connect,
    session: sessionStore,
    createRoom: createRoom,
    joinRoom: joinRoom,
    leaveRoom: leaveRoom,
    addBot: addBot,
    removeLobbyPlayer: removeLobbyPlayer,
    startRoom: startRoom,
    readMeta: readMeta,
    readHostSnapshot: readHostSnapshot,
    watchRoom: watchRoom,
    watchPrivate: watchPrivate,
    RemoteEngine: RemoteEngine,
    HostSession: HostSession
  };
})(window.HiddenSuit);
