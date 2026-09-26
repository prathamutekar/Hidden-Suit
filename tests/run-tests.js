/*
 * Command-line test runner (optional — the game itself needs no Node.js).
 * Loads the browser scripts into a sandbox and runs js/tests.js.
 *
 *   node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console: console, Math: Math };
context.window = context;
vm.createContext(context);

['utils.js', 'deck.js', 'player.js', 'game.js', 'ai.js', 'tests.js'].forEach(function (file) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  vm.runInContext(code, context, { filename: file });
});

const results = context.HiddenSuit.tests.runAll();
let failed = 0;
results.forEach(function (r) {
  console.log((r.passed ? 'PASS ' : 'FAIL ') + r.name);
  r.messages.forEach(function (m) { console.log('     ' + m); });
  if (!r.passed) failed++;
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' tests passed.');
process.exit(failed ? 1 : 0);
