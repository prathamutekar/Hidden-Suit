/*
 * deck.js
 * ---------------------------------------------------------------------------
 * PHASE 1 — Deck and card system.
 *
 * A card looks like:
 *   { id: "AH", rank: "A", value: 14, suit: "hearts", symbol: "♥", color: "red" }
 *
 * Cards are always identified by their unique `id`, never by display text.
 * Card objects are frozen so no code can accidentally change a card.
 */
'use strict';

(function (HS) {
  const { assert, shuffleArray, getSuitInfo } = HS.utils;

  /** Creates a single card object from a rank string and a suit key. */
  function createCard(rank, suitKey) {
    const rankInfo = HS.RANKS.find(function (r) { return r.rank === rank; });
    const suitInfo = getSuitInfo(suitKey);
    assert(rankInfo, 'Unknown rank "' + rank + '"');
    assert(suitInfo, 'Unknown suit "' + suitKey + '"');

    return Object.freeze({
      id: rank + suitInfo.code,  // e.g. "10H", "AS"
      rank: rank,
      value: rankInfo.value,
      suit: suitInfo.key,
      symbol: suitInfo.symbol,
      color: suitInfo.color
    });
  }

  /**
   * Builds a card from its id, e.g. "AH" -> Ace of Hearts, "10D" -> Ten of Diamonds.
   * Used by tests and the debug panel to force specific hands.
   */
  function cardFromId(cardId) {
    const id = String(cardId).toUpperCase();
    const code = id.slice(-1);
    const rank = id.slice(0, -1);
    const suitInfo = HS.SUITS.find(function (s) { return s.code === code; });
    assert(suitInfo, 'Unknown suit code in card id "' + cardId + '"');
    return createCard(rank, suitInfo.key);
  }

  /** Creates a fresh, ordered 52-card deck. */
  function createDeck() {
    const deck = [];
    HS.SUITS.forEach(function (suit) {
      HS.RANKS.forEach(function (rankInfo) {
        deck.push(createCard(rankInfo.rank, suit.key));
      });
    });
    assert(deck.length === HS.DECK_SIZE, 'Deck must contain exactly 52 cards');
    assertNoDuplicateCards(deck);
    return deck;
  }

  /** Returns a shuffled COPY of the deck. Pass a seeded random for determinism. */
  function shuffleDeck(deck, random) {
    return shuffleArray(deck, random);
  }

  /**
   * Deals EVERY card, one at a time, around the table starting with player 0.
   * Hands may be unequal (e.g. 5 players -> 11, 11, 10, 10, 10). No cards remain.
   */
  function dealCards(deck, players) {
    assert(players.length > 0, 'Cannot deal to zero players');
    deck.forEach(function (card, index) {
      players[index % players.length].hand.push(card);
    });
  }

  /** Throws if the same card id appears twice in the list. */
  function assertNoDuplicateCards(cards) {
    const seen = new Set();
    cards.forEach(function (card) {
      assert(!seen.has(card.id), 'Duplicate card detected: ' + card.id);
      seen.add(card.id);
    });
  }

  HS.deck = {
    createCard: createCard,
    cardFromId: cardFromId,
    createDeck: createDeck,
    shuffleDeck: shuffleDeck,
    dealCards: dealCards,
    assertNoDuplicateCards: assertNoDuplicateCards
  };
})(window.HiddenSuit);
