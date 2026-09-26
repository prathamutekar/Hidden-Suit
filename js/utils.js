/*
 * utils.js
 * ---------------------------------------------------------------------------
 * Shared constants and small helper functions used by every other file.
 *
 * WHY NO ES MODULES?
 * Browsers block `<script type="module">` when a page is opened directly from
 * disk (file://). The spec requires the game to run by simply opening
 * index.html, so every file attaches its public functions to ONE global
 * namespace object: `window.HiddenSuit` (aliased as `HS` inside each file).
 * This keeps globals to a single name while still separating responsibilities.
 */
'use strict';

window.HiddenSuit = window.HiddenSuit || {};

(function (HS) {
  /* ------------------------------------------------------------------------
   * CONFIGURATION
   * --------------------------------------------------------------------- */
  HS.config = {
    // Set to true to show the developer testing panel and extra debug info.
    // Debug info NEVER shows hidden cards to normal players.
    DEBUG_MODE: false,

    // Rule 7 says opponents must not learn HOW MANY hidden cards were played.
    // Keep this false to show only "🔒 Hidden cards" publicly.
    SHOW_PUBLIC_HIDDEN_COUNT: false,

    MIN_PLAYERS: 2,
    MAX_PLAYERS: 10,

    // Delay (ms) before an AI player moves, per speed setting.
    AI_DELAYS: { slow: 1500, normal: 900, fast: 350 },

    STORAGE_KEY: 'hiddenSuit.settings.v1'
  };

  /* ------------------------------------------------------------------------
   * CARD CONSTANTS
   * --------------------------------------------------------------------- */
  HS.SUITS = [
    { key: 'hearts',   name: 'Hearts',   symbol: '♥', color: 'red',   code: 'H' },
    { key: 'diamonds', name: 'Diamonds', symbol: '♦', color: 'red',   code: 'D' },
    { key: 'clubs',    name: 'Clubs',    symbol: '♣', color: 'black', code: 'C' },
    { key: 'spades',   name: 'Spades',   symbol: '♠', color: 'black', code: 'S' }
  ];

  // Rank order: 2 < 3 < ... < 10 < J < Q < K < A (Ace is highest).
  HS.RANKS = [
    { rank: '2', value: 2 },  { rank: '3', value: 3 },  { rank: '4', value: 4 },
    { rank: '5', value: 5 },  { rank: '6', value: 6 },  { rank: '7', value: 7 },
    { rank: '8', value: 8 },  { rank: '9', value: 9 },  { rank: '10', value: 10 },
    { rank: 'J', value: 11 }, { rank: 'Q', value: 12 }, { rank: 'K', value: 13 },
    { rank: 'A', value: 14 }
  ];

  HS.DECK_SIZE = HS.SUITS.length * HS.RANKS.length; // 52

  /* ------------------------------------------------------------------------
   * TURN STATE MACHINE
   * Every engine action checks the current state before doing anything, which
   * makes illegal actions (e.g. playing during round resolution) impossible.
   * --------------------------------------------------------------------- */
  HS.STATES = Object.freeze({
    SETUP: 'SETUP',                           // game created, not started
    ROUND_START: 'ROUND_START',               // new round being prepared
    PLAYER_TURN: 'PLAYER_TURN',               // a turn is being set up
    SELECT_CARD: 'SELECT_CARD',               // current player must play one card
    SELECT_HIDDEN_SUIT: 'SELECT_HIDDEN_SUIT', // current player must pick a hidden suit
    ROUND_RESOLUTION: 'ROUND_RESOLUTION',     // round is being resolved
    PLAYER_FINISHED: 'PLAYER_FINISHED',       // finishing players are being recorded
    NEXT_ROUND: 'NEXT_ROUND',                 // waiting for "Continue" to start next round
    GAME_OVER: 'GAME_OVER'                    // only one (or zero) players left
  });

  // Action types the UI (or, later, a network layer) can send to the engine.
  HS.ACTIONS = Object.freeze({
    PLAY_CARD: 'PLAY_CARD',
    PLAY_HIDDEN_SUIT: 'PLAY_HIDDEN_SUIT',
    CONTINUE: 'CONTINUE',
    ACK_NOTICES: 'ACK_NOTICES'
  });

  /* ------------------------------------------------------------------------
   * SMALL HELPERS
   * --------------------------------------------------------------------- */

  /** Throws an Error when a game invariant is broken. */
  function assert(condition, message) {
    if (!condition) {
      throw new Error('[Hidden Suit] Assertion failed: ' + message);
    }
  }

  /** Returns the suit info object ({key, name, symbol, ...}) for a suit key. */
  function getSuitInfo(suitKey) {
    return HS.SUITS.find(function (s) { return s.key === suitKey; }) || null;
  }

  /** "A♥" style label for a card. */
  function formatCard(card) {
    return card.rank + card.symbol;
  }

  /** "6♥, 9♥, K♥" style label for a list of cards. */
  function formatCards(cards) {
    return cards.map(formatCard).join(', ');
  }

  /**
   * Seeded random number generator (mulberry32).
   * The same seed always produces the same sequence, which lets the debug panel
   * create a deterministic deck.
   */
  function createSeededRandom(seed) {
    let t = (Number(seed) >>> 0) || 1;
    return function () {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher–Yates shuffle. Returns a NEW array; the input is not modified. */
  function shuffleArray(items, random) {
    const rng = random || Math.random;
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const temp = copy[i];
      copy[i] = copy[j];
      copy[j] = temp;
    }
    return copy;
  }

  /** Escapes text before inserting it as HTML (player names come from users). */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Minimal event emitter. The game engine extends this so the UI can listen
   * for changes instead of reaching into the engine's state.
   */
  class EventEmitter {
    constructor() {
      this.listeners = {};
    }

    on(eventName, handler) {
      (this.listeners[eventName] = this.listeners[eventName] || []).push(handler);
      return () => this.off(eventName, handler);
    }

    off(eventName, handler) {
      const list = this.listeners[eventName] || [];
      this.listeners[eventName] = list.filter(function (h) { return h !== handler; });
    }

    emit(eventName, payload) {
      (this.listeners[eventName] || []).slice().forEach(function (handler) {
        handler(payload);
      });
    }
  }

  /** localStorage wrapper that never crashes (private mode, file:// quirks). */
  const storage = {
    load: function (key, fallback) {
      try {
        const raw = window.localStorage && window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (err) {
        return fallback;
      }
    },
    save: function (key, value) {
      try {
        if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        /* Storage unavailable: settings simply won't persist. */
      }
    }
  };

  HS.utils = {
    assert: assert,
    getSuitInfo: getSuitInfo,
    formatCard: formatCard,
    formatCards: formatCards,
    createSeededRandom: createSeededRandom,
    shuffleArray: shuffleArray,
    escapeHtml: escapeHtml,
    EventEmitter: EventEmitter,
    storage: storage
  };
})(window.HiddenSuit);
