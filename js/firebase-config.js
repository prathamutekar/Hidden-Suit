/*
 * firebase-config.js
 * ---------------------------------------------------------------------------
 * Connection settings for the Firebase project used by Online Rooms.
 *
 * These values are NOT secret: every Firebase web app ships them to the
 * browser. What protects the data are the security rules in
 * firebase-rules.json (paste them into Firebase → Realtime Database → Rules).
 *
 * To use your own Firebase project, replace the values below with the
 * config from Firebase → Project settings → Your apps → Web app.
 */
'use strict';

window.HiddenSuit = window.HiddenSuit || {};

window.HiddenSuit.firebaseConfig = {
  apiKey: 'AIzaSyCpxQ62w43L8l2JpPuRmvKetOsVwrB6W7A',
  authDomain: 'hidden-suit-e7f38.firebaseapp.com',
  databaseURL: 'https://hidden-suit-e7f38-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'hidden-suit-e7f38',
  storageBucket: 'hidden-suit-e7f38.firebasestorage.app',
  messagingSenderId: '1088909222701',
  appId: '1:1088909222701:web:13425bad7404d4d90969a4'
};
