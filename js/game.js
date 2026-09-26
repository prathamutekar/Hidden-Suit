/*
 * game.js
 * ---------------------------------------------------------------------------
 * THE GAME ENGINE (Phases 3–8).
 *
 * This file contains ALL game rules and NO DOM code. The UI talks to it only
 * through:
 *
 *   engine.dispatch(action)        -> validateMove() -> applyMove() -> emit events
 *   engine.getPublicState()        -> what EVERYONE may see
 *   engine.getPrivateView(playerId)-> what ONE player may see (their hand, etc.)
 *
 * Because every change goes through dispatch(), a future network layer can
 * run this engine on a host device, forward actions from other devices, and
 * send each device only getPublicState() + its own getPrivateView().
 *
 * Events emitted (payloads contain PUBLIC information only):
 *   'stateChanged'   after every successful action
 *   'turnStarted'    { playerId, status }
 *   'cardPlayed'     { playerId, card }
 *   'hiddenPlayed'   { playerId }
 *   'roundResolved'  public round result
 *   'playerFinished' { playerId, position }
 *   'gameOver'       { results }
 *   'invalidMove'    { action, error }
 */
'use strict';

(function (HS) {
  const { assert, formatCard, formatCards, getSuitInfo, createSeededRandom, EventEmitter } = HS.utils;
  const S = HS.STATES;
  const A = HS.ACTIONS;
  const P = HS.player;

  /** The full (authoritative, secret) game state. Never hand this to the UI. */
  function createInitialState() {
    return {
      players: [],
      status: S.SETUP,
      roundNumber: 0,
      currentPlayerIndex: null,    // id of the player whose turn it is
      roundStarterId: null,
      roundParticipants: [],       // active player ids for this round, in turn order
      activeSuit: null,
      forcedLeadSuit: null,        // DEBUG ONLY: starter must lead this suit
      roundCards: [],              // visible plays: [{ playerId, card }]
      hiddenPlays: [],             // secret plays:  [{ playerId, suit, cards }]
      roundType: null,             // 'clean' | 'broken'
      highestActiveSuitCard: null,
      highestPlayerId: null,
      nextStarterId: null,
      finishedPlayers: [],         // ids in finishing order
      discardedCards: [],          // permanently removed cards (clean rounds)
      totalCards: 0,               // card count fixed at initialization
      lastRoundDisplay: [],        // PUBLIC-SAFE record of the last round's plays
      lastRoundResult: null,       // full result (private fields stripped in public view)
      results: null,
      log: [],                     // PUBLIC log entries only
      gameStatus: 'setup'          // 'setup' | 'playing' | 'over' (friendly mirror of status)
    };
  }

  class GameEngine extends EventEmitter {
    constructor() {
      super();
      this.resetGame();
    }

    /* =====================================================================
     * SETUP
     * ================================================================== */

    /** Clears everything back to an empty SETUP state. */
    resetGame() {
      this.state = createInitialState();
      this.privateNotices = {};   // { playerId: [{ id, text, cards, hiddenCards, read }] }
      this.noticeCounter = 0;
      this.random = Math.random;
    }

    /**
     * Creates players and deals cards.
     * options = {
     *   players: [{ name, type: 'human'|'ai' }, ...]   (2–10 entries)
     *   seed:      number   optional, deterministic shuffle + starter
     *   hands:     [[cardId...], ...] optional, FORCE specific hands (tests/debug)
     *   starterId: number   optional, force the first starter
     * }
     */
    initializeGame(options) {
      const playerDefs = options.players || [];
      assert(playerDefs.length >= HS.config.MIN_PLAYERS && playerDefs.length <= HS.config.MAX_PLAYERS,
        'Player count must be between 2 and 10');

      this.resetGame();
      this.random = options.seed !== undefined && options.seed !== null && options.seed !== ''
        ? createSeededRandom(options.seed)
        : Math.random;

      const state = this.state;
      state.players = playerDefs.map(function (def, index) {
        return P.createPlayer(index, def.name, def.type);
      });
      state.players.forEach((p) => { this.privateNotices[p.id] = []; });

      if (options.hands) {
        this.dealForcedHands(options.hands);
      } else {
        const deck = HS.deck.shuffleDeck(HS.deck.createDeck(), this.random);
        assert(deck.length === HS.DECK_SIZE, 'Exactly 52 cards must exist at initialization');
        HS.deck.dealCards(deck, state.players);
      }

      state.players.forEach(function (p) { P.sortHand(p.hand); });
      state.totalCards = state.players.reduce(function (sum, p) { return sum + p.hand.length; }, 0);

      // First round: a random player starts (unless forced).
      const starter = options.starterId !== undefined && options.starterId !== null
        ? options.starterId
        : Math.floor(this.random() * state.players.length);
      assert(state.players[starter], 'Invalid starter id ' + starter);
      state.roundStarterId = starter;

      this.validateGameIntegrity();
      this.setStatus(S.SETUP);
    }

    /** Test/debug helper: gives each player an exact list of card ids. */
    dealForcedHands(hands) {
      const state = this.state;
      assert(hands.length === state.players.length, 'Forced hands must match player count');
      const allCards = [];
      hands.forEach(function (ids, index) {
        assert(ids.length > 0, 'Every player needs at least one card');
        const cards = ids.map(HS.deck.cardFromId);
        state.players[index].hand = cards;
        allCards.push.apply(allCards, cards);
      });
      // A standard deck has only one copy of each card: duplicates are rejected.
      HS.deck.assertNoDuplicateCards(allCards);
      assert(allCards.length <= HS.DECK_SIZE, 'More than 52 cards is impossible');
    }

    startGame() {
      assert(this.state.status === S.SETUP, 'Game can only start from SETUP');
      this.state.gameStatus = 'playing';
      const count = this.state.players.length;
      this.addLog('New game: ' + count + ' players, ' + this.state.totalCards + ' cards dealt.', 'system');
      this.addLog(this.nameOf(this.state.roundStarterId) + ' was randomly chosen to start.', 'system');
      this.startRound(this.state.roundStarterId);
      this.emitStateChange();
    }

    /* =====================================================================
     * ROUNDS & TURNS
     * ================================================================== */

    /** Starts a new round led by `starterId`. The fixed circular order never changes. */
    startRound(starterId) {
      const state = this.state;
      assert(this.isActive(starterId), 'Round starter must be an active player');
      this.setStatus(S.ROUND_START);

      state.roundNumber += 1;
      state.roundStarterId = starterId;
      state.activeSuit = null;
      state.forcedLeadSuit = null;
      state.roundCards = [];
      state.hiddenPlays = [];
      state.roundType = null;
      state.highestActiveSuitCard = null;
      state.highestPlayerId = null;
      state.nextStarterId = null;
      state.lastRoundDisplay = [];
      state.lastRoundResult = null;
      state.roundParticipants = this.getActivePlayersFrom(starterId);

      this.addLog('— Round ' + state.roundNumber + ' — ' + this.nameOf(starterId) + ' starts.', 'round');
      this.beginTurn(starterId);
    }

    /** Puts the game into the correct selection state for this player's turn. */
    beginTurn(playerId) {
      const state = this.state;
      this.setStatus(S.PLAYER_TURN);
      state.currentPlayerIndex = playerId;

      // The starter may play anything; followers either follow suit or must hide a suit.
      const mustHide = !this.isStarterTurn() && !this.hasActiveSuit(playerId);
      this.setStatus(mustHide ? S.SELECT_HIDDEN_SUIT : S.SELECT_CARD);
      this.emit('turnStarted', { playerId: playerId, status: state.status });
    }

    /** True when nobody has played yet this round (the starter's free choice). */
    isStarterTurn() {
      return this.state.roundCards.length === 0 && this.state.activeSuit === null;
    }

    /** Circular order starting at `startId`, only players who are still active. */
    getActivePlayersFrom(startId) {
      const players = this.state.players;
      const order = [];
      for (let offset = 0; offset < players.length; offset++) {
        const player = players[(startId + offset) % players.length];
        if (player.status === 'active') order.push(player.id);
      }
      return order;
    }

    /** The next ACTIVE player after `fromId` in the fixed circular order. */
    getNextActivePlayer(fromId) {
      const players = this.state.players;
      for (let offset = 1; offset <= players.length; offset++) {
        const player = players[(fromId + offset) % players.length];
        if (player.status === 'active') return player.id;
      }
      return null;
    }

    /* =====================================================================
     * RULE QUERIES
     * ================================================================== */

    hasActiveSuit(playerId) {
      const suit = this.state.activeSuit;
      return suit !== null && P.getCardsOfSuit(this.getPlayer(playerId), suit).length > 0;
    }

    /** Cards this player may legally play right now (empty if not their card turn). */
    getLegalCards(playerId) {
      const state = this.state;
      if (state.status !== S.SELECT_CARD || state.currentPlayerIndex !== playerId) return [];
      const player = this.getPlayer(playerId);

      if (this.isStarterTurn()) {
        if (state.forcedLeadSuit) return P.getCardsOfSuit(player, state.forcedLeadSuit);
        return player.hand.slice();            // starter: ANY card
      }
      return P.getCardsOfSuit(player, state.activeSuit); // follower: active suit only
    }

    /** Suits the player may choose for a hidden play (only suits they actually hold). */
    getHiddenSuitOptions(playerId) {
      const state = this.state;
      if (state.status !== S.SELECT_HIDDEN_SUIT || state.currentPlayerIndex !== playerId) return [];
      const player = this.getPlayer(playerId);
      return P.getSuitsInHand(player).map(function (suitKey) {
        return { suit: suitKey, count: P.getCardsOfSuit(player, suitKey).length };
      });
    }

    /* =====================================================================
     * ACTIONS: validateMove() -> applyMove() -> emitStateChange()
     * ================================================================== */

    dispatch(action) {
      const error = this.validateMove(action);
      if (error) {
        this.emit('invalidMove', { action: action, error: error });
        return { ok: false, error: error };
      }
      this.applyMove(action);
      this.validateGameIntegrity();
      this.emitStateChange();
      return { ok: true };
    }

    /** Returns an error message, or null when the action is legal. */
    validateMove(action) {
      if (!action || !action.type) return 'Unknown action.';
      switch (action.type) {
        case A.PLAY_CARD:        return this.validateVisiblePlay(action.playerId, action.cardId);
        case A.PLAY_HIDDEN_SUIT: return this.validateHiddenPlay(action.playerId, action.suit, action.cardIds);
        case A.CONTINUE:
          return this.state.status === S.NEXT_ROUND ? null : 'The game is not waiting for the next round.';
        case A.ACK_NOTICES:
          return this.getPlayer(action.playerId) ? null : 'Unknown player.';
        default:
          return 'Unknown action type "' + action.type + '".';
      }
    }

    applyMove(action) {
      switch (action.type) {
        case A.PLAY_CARD:        this.playVisibleCard(action.playerId, action.cardId); break;
        case A.PLAY_HIDDEN_SUIT: this.chooseHiddenSuit(action.playerId, action.suit); break;
        case A.CONTINUE:         this.startNextRound(); break;
        case A.ACK_NOTICES:      this.acknowledgeNotices(action.playerId); break;
      }
    }

    /** Shared checks: right state, right player, player still in the game. */
    validateTurnOwner(playerId) {
      const state = this.state;
      const player = this.getPlayer(playerId);
      if (!player) return 'Unknown player.';
      if (player.status !== 'active') return 'Finished players cannot take turns.';
      if (state.currentPlayerIndex !== playerId) return 'It is not ' + player.name + "'s turn.";
      return null;
    }

    validateVisiblePlay(playerId, cardId) {
      const state = this.state;
      if (state.status === S.SELECT_HIDDEN_SUIT && state.currentPlayerIndex === playerId) {
        return 'You have no ' + getSuitInfo(state.activeSuit).name + '. Choose a suit to play secretly.';
      }
      if (state.status !== S.SELECT_CARD) return 'Cards cannot be played right now.';
      const ownerError = this.validateTurnOwner(playerId);
      if (ownerError) return ownerError;

      const player = this.getPlayer(playerId);
      const card = player.hand.find(function (c) { return c.id === cardId; });
      if (!card) return 'That card is not in your hand.';

      const legal = this.getLegalCards(playerId).some(function (c) { return c.id === cardId; });
      if (!legal) {
        const suitKey = this.isStarterTurn() ? state.forcedLeadSuit : state.activeSuit;
        return 'You must follow ' + getSuitInfo(suitKey).name + '.';
      }
      return null;
    }

    validateHiddenPlay(playerId, suitKey, cardIds) {
      const state = this.state;
      if (state.status !== S.SELECT_HIDDEN_SUIT) {
        return state.status === S.SELECT_CARD
          ? 'You can follow the active suit, so you must play one card of it.'
          : 'A hidden play is not allowed right now.';
      }
      const ownerError = this.validateTurnOwner(playerId);
      if (ownerError) return ownerError;

      if (!getSuitInfo(suitKey)) return 'Unknown suit.';
      if (this.hasActiveSuit(playerId)) return 'You must follow the active suit.';

      const player = this.getPlayer(playerId);
      const suitCards = P.getCardsOfSuit(player, suitKey);
      if (suitCards.length === 0) return 'You do not have any ' + getSuitInfo(suitKey).name + '.';

      // The hidden play is ALWAYS every card of the suit. If a caller lists
      // specific cards, they must be exactly that full set.
      if (cardIds) {
        const expected = suitCards.map(function (c) { return c.id; }).sort().join(',');
        const given = cardIds.slice().sort().join(',');
        if (expected !== given) return 'You must play ALL of your ' + getSuitInfo(suitKey).name + ', not only some.';
      }
      return null;
    }

    /* =====================================================================
     * PLAYING CARDS
     * ================================================================== */

    /** A normal, face-up play of exactly one card. */
    playVisibleCard(playerId, cardId) {
      const state = this.state;
      const player = this.getPlayer(playerId);
      const card = P.removeCardFromHand(player, cardId);

      // The starter's card establishes the active suit.
      if (state.activeSuit === null) {
        state.activeSuit = card.suit;
        this.addLog(player.name + ' led ' + formatCard(card) + '. Active suit: ' +
          getSuitInfo(card.suit).name + '.', 'play');
      } else {
        this.addLog(player.name + ' played ' + formatCard(card) + '.', 'play');
      }
      state.roundCards.push({ playerId: playerId, card: card });
      this.updateHighestCard();
      this.emit('cardPlayed', { playerId: playerId, card: card });

      // Everyone in the round has now played one active-suit card -> CLEAN ROUND.
      if (state.roundCards.length === state.roundParticipants.length) {
        this.resolveCleanRound();
        return;
      }
      this.beginTurn(state.roundParticipants[state.roundCards.length]);
    }

    /** The player couldn't follow suit and picked `suitKey` to play secretly. */
    chooseHiddenSuit(playerId, suitKey) {
      this.playHiddenSuit(playerId, suitKey);
      this.endRoundImmediately();
    }

    /**
     * HIDDEN-SUIT MECHANIC: removes ALL cards of the chosen suit from the hand
     * and stores them face-down. Only the player (and later the collector)
     * ever learns what they were.
     */
    playHiddenSuit(playerId, suitKey) {
      const state = this.state;
      const player = this.getPlayer(playerId);
      const cards = P.removeSuitFromHand(player, suitKey);
      assert(cards.length > 0, 'Hidden play must contain at least one card');

      state.hiddenPlays.push({ playerId: playerId, suit: suitKey, cards: cards });

      // Public log: no suit, no card names, no count.
      this.addLog(player.name + ' could not follow ' + getSuitInfo(state.activeSuit).name + '.', 'hidden');
      this.addLog(player.name + ' secretly played ' + this.publicHiddenLabel(cards.length) + '.', 'hidden');

      // Private note for the player who hid the cards (count only, per the spec).
      this.addPrivateNotice(playerId, {
        text: '🔒 You secretly played ' + cards.length + ' ' + getSuitInfo(suitKey).name +
          ' card' + (cards.length === 1 ? '' : 's') + '.'
      });
      this.emit('hiddenPlayed', { playerId: playerId });
    }

    /** A hidden play ends the round at once: no later player gets a turn. */
    endRoundImmediately() {
      this.state.currentPlayerIndex = null;
      this.addLog('Round ended immediately.', 'round');
      this.resolveBrokenRound();
    }

    /* =====================================================================
     * ROUND RESOLUTION
     * ================================================================== */

    /** Highest card of the ORIGINAL active suit among visible plays. */
    determineHighestActiveSuitCard() {
      const state = this.state;
      let best = null;
      state.roundCards.forEach(function (play) {
        if (play.card.suit !== state.activeSuit) return;
        if (!best || play.card.value > best.card.value) best = play;
      });
      return best; // { playerId, card } or null
    }

    updateHighestCard() {
      const best = this.determineHighestActiveSuitCard();
      this.state.highestActiveSuitCard = best ? best.card : null;
      this.state.highestPlayerId = best ? best.playerId : null;
    }

    /** BROKEN ROUND: the highest active-suit card collects EVERYTHING, hidden cards included. */
    resolveBrokenRound() {
      const state = this.state;
      this.setStatus(S.ROUND_RESOLUTION);
      state.roundType = 'broken';

      const best = this.determineHighestActiveSuitCard();
      assert(best, 'A broken round always has at least the starter\'s active-suit card');
      const hidden = state.hiddenPlays[0];
      const visibleCards = state.roundCards.map(function (p) { return p.card; });
      const collector = this.getPlayer(best.playerId);

      state.lastRoundDisplay = this.buildPublicRoundDisplay();
      this.collectRoundCards(best.playerId);

      // Only the collector learns the hidden cards.
      this.addPrivateNotice(best.playerId, {
        text: 'You collected round ' + state.roundNumber + '. Visible: ' + formatCards(visibleCards) +
          '. Hidden cards from ' + this.nameOf(hidden.playerId) + ':',
        cards: visibleCards,
        hiddenCards: hidden.cards
      });

      this.addLog(collector.name + ' had the highest ' + getSuitInfo(state.activeSuit).name +
        ' (' + formatCard(best.card) + ') and collected ' + visibleCards.length +
        ' visible card' + (visibleCards.length === 1 ? '' : 's') + ' + hidden cards.', 'collect');

      this.finishRound({
        type: 'broken',
        roundNumber: state.roundNumber,
        activeSuit: state.activeSuit,
        highestCard: best.card,
        highestPlayerId: best.playerId,
        collectorId: best.playerId,
        visibleCount: visibleCards.length,
        hiddenPlayerId: hidden.playerId,
        hiddenCount: hidden.cards.length   // stripped from the public view
      });
    }

    /** CLEAN ROUND: nobody collects; every played card is removed permanently. */
    resolveCleanRound() {
      const state = this.state;
      this.setStatus(S.ROUND_RESOLUTION);
      state.currentPlayerIndex = null;
      state.roundType = 'clean';

      const best = this.determineHighestActiveSuitCard();
      assert(best, 'A clean round always has a highest card');
      const removedCount = state.roundCards.length;

      state.lastRoundDisplay = this.buildPublicRoundDisplay();
      this.discardRoundCards();

      this.addLog('Clean round! Everyone followed ' + getSuitInfo(state.activeSuit).name + '. ' +
        removedCount + ' cards removed from the game.', 'clean');

      this.finishRound({
        type: 'clean',
        roundNumber: state.roundNumber,
        activeSuit: state.activeSuit,
        highestCard: best.card,
        highestPlayerId: best.playerId,
        removedCount: removedCount
      });
    }

    /** Clean round: round cards -> discardedCards (never to return). */
    discardRoundCards() {
      const state = this.state;
      state.roundCards.forEach(function (play) { state.discardedCards.push(play.card); });
      state.roundCards = [];
      state.hiddenPlays = [];
    }

    /** Broken round: visible + hidden cards -> collector's hand. */
    collectRoundCards(collectorId) {
      const state = this.state;
      const collected = state.roundCards.map(function (p) { return p.card; });
      state.hiddenPlays.forEach(function (h) { collected.push.apply(collected, h.cards); });
      P.addCardsToHand(this.getPlayer(collectorId), collected);
      state.roundCards = [];
      state.hiddenPlays = [];
    }

    /**
     * Shared tail of both round types.
     * EDGE CASE (rule 20): players who emptied their hand mid-round are only
     * marked FINISHED here, AFTER the round has been resolved normally.
     */
    finishRound(result) {
      const state = this.state;
      state.lastRoundResult = result;

      this.setStatus(S.PLAYER_FINISHED);
      result.finishedThisRound = [];
      state.roundParticipants.forEach((playerId) => {
        if (this.checkPlayerFinished(playerId)) {
          this.finishPlayer(playerId);
          result.finishedThisRound.push(playerId);
        }
      });

      if (this.checkGameOver()) {
        this.endGame();
        return;
      }

      // The highest-card player starts next. If they just went out, the next
      // active player after them (in the fixed circular order) starts instead.
      const nextStarter = this.isActive(result.highestPlayerId)
        ? result.highestPlayerId
        : this.getNextActivePlayer(result.highestPlayerId);
      result.nextStarterId = nextStarter;
      state.nextStarterId = nextStarter;
      this.addLog(this.nameOf(nextStarter) + ' starts the next round.', 'round');

      this.setStatus(S.NEXT_ROUND);
      this.emit('roundResolved', this.toPublicResult(result));
    }

    startNextRound() {
      this.startRound(this.state.nextStarterId);
    }

    /* =====================================================================
     * FINISHING & GAME OVER
     * ================================================================== */

    checkPlayerFinished(playerId) {
      const player = this.getPlayer(playerId);
      return player.status === 'active' && player.hand.length === 0;
    }

    finishPlayer(playerId) {
      const state = this.state;
      const player = this.getPlayer(playerId);
      assert(player.hand.length === 0, 'Only players with 0 cards can finish');
      state.finishedPlayers.push(playerId);
      player.status = 'finished';
      player.finishPosition = state.finishedPlayers.length;
      this.addLog('🏁 ' + player.name + ' finished #' + player.finishPosition + '!', 'finish');
      this.emit('playerFinished', { playerId: playerId, position: player.finishPosition });
    }

    /** Game ends when one player (or, rarely, nobody) still has cards. */
    checkGameOver() {
      return this.state.players.filter(function (p) { return p.status === 'active'; }).length <= 1;
    }

    endGame() {
      const state = this.state;
      const remaining = state.players.find(function (p) { return p.status === 'active'; });
      if (remaining) {
        remaining.status = 'loser';
        remaining.finishPosition = state.players.length;
        this.addLog('💀 ' + remaining.name + ' is the last player holding cards — LOSER!', 'gameover');
      } else {
        this.addLog('Everyone emptied their hand in the same round — there is no loser!', 'gameover');
      }
      state.currentPlayerIndex = null;
      state.results = this.calculateResults();
      state.gameStatus = 'over';
      this.setStatus(S.GAME_OVER);
      this.emit('gameOver', { results: state.results });
    }

    /** Final standings: finishers in order, then the loser (if any). */
    calculateResults() {
      const state = this.state;
      const results = state.finishedPlayers.map((id, index) => ({
        playerId: id, name: this.nameOf(id), position: index + 1, isLoser: false
      }));
      const loser = state.players.find(function (p) { return p.status === 'loser'; });
      if (loser) {
        results.push({ playerId: loser.id, name: loser.name, position: 'Last',
          isLoser: true, cardsLeft: loser.hand.length });
      }
      return results;
    }

    /* =====================================================================
     * PRIVATE NOTICES (information only one player may see)
     * ================================================================== */

    addPrivateNotice(playerId, notice) {
      this.noticeCounter += 1;
      this.privateNotices[playerId].push({
        id: this.noticeCounter,
        round: this.state.roundNumber,
        text: notice.text,
        cards: notice.cards || [],
        hiddenCards: notice.hiddenCards || [],
        read: false
      });
    }

    acknowledgeNotices(playerId) {
      (this.privateNotices[playerId] || []).forEach(function (n) { n.read = true; });
    }

    /* =====================================================================
     * VIEWS — the ONLY data the UI receives
     * ================================================================== */

    /** Information every player at the table may see. Contains NO hidden cards. */
    getPublicState() {
      const state = this.state;
      const inRound = state.status === S.SELECT_CARD || state.status === S.SELECT_HIDDEN_SUIT;
      return {
        status: state.status,
        gameStatus: state.gameStatus,
        roundNumber: state.roundNumber,
        currentPlayerId: state.currentPlayerIndex,
        roundStarterId: state.roundStarterId,
        activeSuit: state.activeSuit,
        highestCard: state.highestActiveSuitCard,
        highestPlayerId: state.highestPlayerId,
        nextStarterId: state.nextStarterId,
        roundPlays: inRound ? this.buildPublicRoundDisplay() : state.lastRoundDisplay.slice(),
        players: state.players.map(function (p) {
          return { id: p.id, name: p.name, type: p.type, handCount: p.hand.length,
            status: p.status, finishPosition: p.finishPosition };
        }),
        finishedPlayers: state.finishedPlayers.slice(),
        discardedCount: state.discardedCards.length,
        // Clean-round cards were played face up, so which ones left the game is public.
        discardedCards: state.discardedCards.slice(),
        lastRoundResult: state.lastRoundResult ? this.toPublicResult(state.lastRoundResult) : null,
        results: state.results ? state.results.slice() : null,
        log: state.log.slice()
      };
    }

    /** Information only `playerId` may see: their hand, legal moves, private notices. */
    getPrivateView(playerId) {
      const player = this.getPlayer(playerId);
      if (!player) return null;
      const state = this.state;
      const legalIds = this.getLegalCards(playerId).map(function (c) { return c.id; });
      const notices = this.privateNotices[playerId] || [];
      const lastResult = state.lastRoundResult;

      return {
        playerId: playerId,
        name: player.name,
        hand: player.hand.slice(),
        legalCardIds: legalIds,
        isMyTurn: state.currentPlayerIndex === playerId &&
          (state.status === S.SELECT_CARD || state.status === S.SELECT_HIDDEN_SUIT),
        isStarter: this.isStarterTurn() && state.currentPlayerIndex === playerId,
        mustPlayHidden: state.status === S.SELECT_HIDDEN_SUIT && state.currentPlayerIndex === playerId,
        hiddenSuitOptions: this.getHiddenSuitOptions(playerId),
        forcedLeadSuit: state.forcedLeadSuit,
        unreadNotices: notices.filter(function (n) { return !n.read; }),
        allNotices: notices.slice(),
        // Hidden count is private to the hider and the collector.
        lastRoundHiddenCount: lastResult && lastResult.type === 'broken' &&
          (lastResult.hiddenPlayerId === playerId || lastResult.collectorId === playerId)
          ? lastResult.hiddenCount : null
      };
    }

    /** Round plays with hidden plays reduced to a face-down marker. */
    buildPublicRoundDisplay() {
      const state = this.state;
      const visible = state.roundCards.map(function (p) {
        return { playerId: p.playerId, kind: 'visible', card: p.card };
      });
      const hidden = state.hiddenPlays.map(function (h) {
        return { playerId: h.playerId, kind: 'hidden',
          count: HS.config.SHOW_PUBLIC_HIDDEN_COUNT ? h.cards.length : null };
      });
      return visible.concat(hidden);
    }

    toPublicResult(result) {
      const copy = Object.assign({}, result);
      if (!HS.config.SHOW_PUBLIC_HIDDEN_COUNT) delete copy.hiddenCount;
      return copy;
    }

    publicHiddenLabel(count) {
      return HS.config.SHOW_PUBLIC_HIDDEN_COUNT ? count + ' hidden card' + (count === 1 ? '' : 's') : 'hidden cards';
    }

    /* =====================================================================
     * VALIDATION (runs after every action)
     * ================================================================== */

    /**
     * Checks global invariants: no duplicates, card total never changes,
     * never more than 52 cards, finished players hold nothing, discarded
     * cards never return to a hand.
     */
    validateGameIntegrity() {
      const state = this.state;
      const all = [];
      state.players.forEach(function (p) {
        assert(p.hand.length >= 0, 'Hand size cannot be negative');
        if (p.status === 'finished') assert(p.hand.length === 0, p.name + ' is finished but holds cards');
        all.push.apply(all, p.hand);
      });
      state.roundCards.forEach(function (play) { all.push(play.card); });
      state.hiddenPlays.forEach(function (h) { all.push.apply(all, h.cards); });
      all.push.apply(all, state.discardedCards);

      HS.deck.assertNoDuplicateCards(all); // also guarantees discarded cards are in no hand
      assert(all.length === state.totalCards,
        'Card count changed: expected ' + state.totalCards + ', found ' + all.length);
      assert(all.length <= HS.DECK_SIZE, 'More than 52 cards exist');
      return true;
    }

    /* =====================================================================
     * SAVE / RESTORE (online host resumes after a page refresh)
     * The snapshot contains ALL secrets, so it is only ever sent to the
     * server under the host's private token — never to other players.
     * ================================================================== */

    exportState() {
      return JSON.parse(JSON.stringify({
        state: this.state,
        privateNotices: this.privateNotices,
        noticeCounter: this.noticeCounter
      }));
    }

    importState(snapshot) {
      this.state = snapshot.state;
      this.privateNotices = snapshot.privateNotices;
      this.noticeCounter = snapshot.noticeCounter;
      this.random = Math.random;
      this.validateGameIntegrity();
    }

    /* =====================================================================
     * DEBUG HELPERS (used only by the debug panel)
     * ================================================================== */

    /** Make a different active player start the current round (before any card is played). */
    debugForceCurrentPlayer(playerId) {
      assert(this.isStarterTurn() && this.state.status === S.SELECT_CARD, 'Only possible before the first card');
      assert(this.isActive(playerId), 'Player must be active');
      this.state.roundNumber -= 1; // startRound will add it back
      this.startRound(playerId);
      this.emitStateChange();
    }

    /** Force the starter to lead a particular suit (they must hold it). */
    debugForceActiveSuit(suitKey) {
      assert(this.isStarterTurn() && this.state.status === S.SELECT_CARD, 'Only possible before the first card');
      const starter = this.getPlayer(this.state.currentPlayerIndex);
      assert(P.getCardsOfSuit(starter, suitKey).length > 0, starter.name + ' holds no ' + suitKey);
      this.state.forcedLeadSuit = suitKey;
      this.emitStateChange();
    }

    /* =====================================================================
     * SMALL INTERNAL HELPERS
     * ================================================================== */

    getPlayer(playerId) {
      return this.state.players[playerId] || null;
    }

    isActive(playerId) {
      const p = this.getPlayer(playerId);
      return !!p && p.status === 'active';
    }

    nameOf(playerId) {
      const p = this.getPlayer(playerId);
      return p ? p.name : '?';
    }

    setStatus(status) {
      this.state.status = status;
    }

    addLog(text, type) {
      this.state.log.push({ round: this.state.roundNumber, text: text, type: type || 'info' });
    }

    emitStateChange() {
      this.emit('stateChanged', this.getPublicState());
    }
  }

  HS.GameEngine = GameEngine;
})(window.HiddenSuit);
