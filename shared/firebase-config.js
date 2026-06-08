/**
 * shared/firebase-config.js — Centralized Firebase configuration.
 *
 * This file is imported by both browser (auth.js via CDN) and Node.js (generate-code.js via npm).
 * The actual initializeApp() calls remain in the consuming modules since they
 * use different import sources (CDN vs npm).
 */

export const firebaseConfig = {
  apiKey: "AIzaSyCaJnNR5WOKY9tHg6X9IWpcQcBKHJpvTrk",
  authDomain: "openfront-speedrun.firebaseapp.com",
  projectId: "openfront-speedrun",
  storageBucket: "openfront-speedrun.firebasestorage.app",
  messagingSenderId: "710681441859",
  appId: "1:710681441859:web:a01003e5b07c83ea50c6f6",
  measurementId: "G-SD1GNCN8NV"
};
