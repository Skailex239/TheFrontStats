/**
 * auth.js — Firebase Auth + Firestore wrapper for TheFrontStats.
 *
 * - signInWithPopup (Google / Discord OIDC) with signInWithRedirect fallback
 * - getRedirectResult handled on page load
 * - browserLocalPersistence for cross-session login
 * - Safe showToast (toast.js may not be loaded yet)
 *
 * Exports both ES module symbols (for app.js / profile.js) AND window.*
 * globals (for inline HTML onclick handlers like handleLogin).
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  signOut,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
  increment,
  deleteField,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./shared/firebase-config.js";

/* ── Firebase init ── */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Keep user logged in across browser sessions
setPersistence(auth, browserLocalPersistence).catch((e) =>
  console.warn("[auth] setPersistence failed:", e.message)
);

/* ── Providers ── */
const googleProvider = new GoogleAuthProvider();
const discordProvider = new OAuthProvider("oidc.discord");

/* ── Exports (ES module) ── */
export {
  auth, db,
  doc, getDoc, getDocs, setDoc, updateDoc,
  collection, query, where, onSnapshot,
  increment, deleteField, runTransaction,
  googleProvider, discordProvider,
  signInWithPopup, signOut, onAuthStateChanged,
};

/* ── Helpers ── */

// toast.js may not be loaded yet when auth.js runs (it's deferred).
function safeShowToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") {
    window.showToast(msg, type, duration);
    return;
  }
  console.log(`[auth/toast:${type}]`, msg);
  // Retry once after toast.js has likely loaded
  setTimeout(() => {
    if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  }, 600);
}

function buildErrorMessage(provider, error) {
  const map = {
    "auth/unauthorized-domain": `Ce domaine n'est pas autorisé dans la console Firebase. Demandez à l'administrateur d'ajouter ce domaine dans Authentication → Settings → Authorized domains.`,
    "auth/operation-not-allowed": `La connexion ${provider} n'est pas activée dans la console Firebase (Authentication → Sign-in method).`,
    "auth/account-exists-with-different-credential": `Un compte existe déjà avec cette adresse email via un autre fournisseur. Connectez-vous avec ce même fournisseur pour accéder à votre compte existant.`,
    "auth/popup-closed-by-user": `La fenêtre de connexion a été fermée avant la fin. Réessayez.`,
    "auth/cancelled-popup-request": "", // silent
    "auth/popup-blocked": `Le popup a été bloqué par le navigateur. Utilisation de la redirection à la place...`,
    "auth/redirect-operation-pending": "", // silent
    "auth/network-request-failed": `Erreur réseau. Vérifiez votre connexion internet et réessayez.`,
  };
  const tail = map[error.code];
  if (tail === undefined) {
    return `Erreur lors de la connexion ${provider} : ${error.message || error.code}`;
  }
  if (tail === "") return "";
  return `Erreur lors de la connexion ${provider}.\n\n${tail}`;
}

/* ── Handle redirect result on page load ── */
getRedirectResult(auth)
  .then((result) => {
    if (result && result.user) {
      console.log("[auth] Redirect sign-in successful:", result.user.displayName || result.user.email);
      // Mark fresh login so onAuthStateChanged in app.js / profile.js can react
      try { sessionStorage.setItem("tfs_just_logged_in", "1"); } catch {}
      safeShowToast("Connexion réussie !", "success", 3000);
    }
  })
  .catch((error) => {
    console.error("[auth] Redirect result error:", error);
    const msg = buildErrorMessage("redirect", error);
    if (msg) safeShowToast(msg, "error", 6000);
  });

/* ── Login function: popup → redirect fallback ── */
async function loginWithProvider(providerName, providerInstance) {
  console.log(`[auth] Starting ${providerName} login (popup mode)...`);
  try {
    const result = await signInWithPopup(auth, providerInstance);
    console.log("[auth] Popup sign-in successful:", result.user.displayName || result.user.email);
    try { sessionStorage.setItem("tfs_just_logged_in", "1"); } catch {}
    return result.user;
  } catch (error) {
    console.error(`[auth] Popup ${providerName} failed:`, error.code, error.message);

    // Popup blocked or already pending → fallback to redirect (more robust on mobile / iframe sandbox)
    if (
      error.code === "auth/popup-blocked" ||
      error.code === "auth/cancelled-popup-request"
    ) {
      console.log(`[auth] Falling back to redirect mode for ${providerName}...`);
      safeShowToast(`Redirection vers ${providerName}...`, "info", 2500);
      try {
        await signInWithRedirect(auth, providerInstance);
        return null; // Page will navigate away
      } catch (redirectError) {
        console.error(`[auth] Redirect ${providerName} also failed:`, redirectError);
        const msg = buildErrorMessage(providerName, redirectError);
        if (msg) safeShowToast(msg, "error", 6000);
        throw redirectError;
      }
    }

    // For other errors, show toast and re-throw
    const msg = buildErrorMessage(providerName, error);
    if (msg) safeShowToast(msg, "error", 6000);
    throw error;
  }
}

/* ── Window globals (for inline HTML onclick handlers) ── */
window.loginWithGoogle = () => loginWithProvider("Google", googleProvider);
window.loginWithDiscord = () => loginWithProvider("Discord", discordProvider);
window.logout = () => signOut(auth);
