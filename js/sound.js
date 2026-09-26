/*
 * sound.js
 * ---------------------------------------------------------------------------
 * PHASE 12 — Tiny sound effects generated with the Web Audio API.
 * No audio files are needed. Sounds are optional and can be switched off.
 */
'use strict';

(function (HS) {
  let audioContext = null;
  let enabled = true;

  /** Lazily creates the AudioContext (browsers require a user gesture first). */
  function getContext() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      audioContext = new AudioCtx();
    }
    if (audioContext.state === 'suspended') audioContext.resume();
    return audioContext;
  }

  /** Plays one short tone. */
  function tone(frequency, startOffset, duration, type, volume) {
    const ctx = getContext();
    if (!ctx) return;
    const start = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume || 0.15, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  // Each effect is a short sequence of [frequency, offset, duration, wave, volume].
  const EFFECTS = {
    card:     [[520, 0, 0.08, 'triangle', 0.12], [380, 0.03, 0.06, 'triangle', 0.08]],
    hidden:   [[220, 0, 0.18, 'sine', 0.16], [165, 0.1, 0.22, 'sine', 0.12]],
    clean:    [[523, 0, 0.12, 'sine'], [659, 0.1, 0.12, 'sine'], [784, 0.2, 0.2, 'sine']],
    collect:  [[392, 0, 0.12, 'square', 0.06], [294, 0.12, 0.2, 'square', 0.06]],
    finished: [[659, 0, 0.12, 'triangle'], [784, 0.12, 0.12, 'triangle'], [1047, 0.24, 0.3, 'triangle']],
    gameover: [[523, 0, 0.2, 'sine'], [415, 0.2, 0.2, 'sine'], [349, 0.4, 0.2, 'sine'], [262, 0.6, 0.5, 'sine']],
    error:    [[160, 0, 0.15, 'sawtooth', 0.06]],
    turn:     [[880, 0, 0.06, 'sine', 0.08]]
  };

  function play(effectName) {
    if (!enabled || !EFFECTS[effectName]) return;
    try {
      EFFECTS[effectName].forEach(function (t) { tone(t[0], t[1], t[2], t[3], t[4]); });
    } catch (err) {
      /* Audio problems must never break the game. */
    }
  }

  HS.sound = {
    play: play,
    setEnabled: function (value) { enabled = !!value; },
    isEnabled: function () { return enabled; }
  };
})(window.HiddenSuit);
