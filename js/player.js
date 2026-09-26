/*
 * player.js
 * ---------------------------------------------------------------------------
 * PHASE 2 — Player creation and hand helpers.
 *
 * A player looks like:
 *   { id: 0, name: "Player 1", type: "human" | "ai", hand: [],
 *     status: "active" | "finished" | "loser", finishPosition: null }
 */
'use strict';

(function (HS) {
  const { assert } = HS.utils;

  function createPlayer(id, name, type) {
    return {
      id: id,
      name: name || 'Player ' + (id + 1),
      type: type === 'ai' ? 'ai' : 'human',
      hand: [],
      status: 'active',
      finishPosition: null
    };
  }

  /** Sorts a hand by suit (♥ ♦ ♣ ♠) and then by rank, lowest first. */
  function sortHand(hand) {
    const suitOrder = HS.SUITS.map(function (s) { return s.key; });
    return hand.sort(function (a, b) {
      const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
      return suitDiff !== 0 ? suitDiff : a.value - b.value;
    });
  }

  function hasCard(player, cardId) {
    return player.hand.some(function (c) { return c.id === cardId; });
  }

  function getCardsOfSuit(player, suitKey) {
    return player.hand.filter(function (c) { return c.suit === suitKey; });
  }

  /** Suit keys the player currently holds at least one card of. */
  function getSuitsInHand(player) {
    return HS.SUITS
      .map(function (s) { return s.key; })
      .filter(function (key) { return getCardsOfSuit(player, key).length > 0; });
  }

  /** Removes one card from the hand and returns it. Throws if it isn't there. */
  function removeCardFromHand(player, cardId) {
    const index = player.hand.findIndex(function (c) { return c.id === cardId; });
    assert(index !== -1, player.name + ' does not hold card ' + cardId);
    return player.hand.splice(index, 1)[0];
  }

  /** Removes ALL cards of one suit and returns them. */
  function removeSuitFromHand(player, suitKey) {
    const removed = getCardsOfSuit(player, suitKey);
    player.hand = player.hand.filter(function (c) { return c.suit !== suitKey; });
    return removed;
  }

  function addCardsToHand(player, cards) {
    cards.forEach(function (card) {
      assert(!hasCard(player, card.id), 'Card ' + card.id + ' is already in ' + player.name + "'s hand");
      player.hand.push(card);
    });
    sortHand(player.hand);
  }

  HS.player = {
    createPlayer: createPlayer,
    sortHand: sortHand,
    hasCard: hasCard,
    getCardsOfSuit: getCardsOfSuit,
    getSuitsInHand: getSuitsInHand,
    removeCardFromHand: removeCardFromHand,
    removeSuitFromHand: removeSuitFromHand,
    addCardsToHand: addCardsToHand
  };
})(window.HiddenSuit);
