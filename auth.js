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
  collection,
  query,
  where,
  onSnapshot,
  updateDoc,
  increment,
  deleteField,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./shared/firebase-config.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Explicit persistence — keep user logged in across browser sessions
setPersistence(auth, browserLocalPersistence).catch((e) =>
  console.warn("[auth] setPersistence failed:", e.message)
);

// Providers
const googleProvider = new GoogleAuthProvider();
const discordProvider = new OAuthProvider('oidc.discord');

export {
  auth, db, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, onSnapshot, increment, deleteField, runTransaction,
  googleProvider, discordProvider, signInWithPopup, signOut, onAuthStateChanged,
};

// Safe showToast — toast.js is loaded with defer, might not be ready yet
function safeShowToast(msg, type, duration) {
  if (typeof window.showToast === 'function') {
    window.showToast(msg, type, duration);
  } else {
    console.warn("[auth] showToast not available:", msg);
    // Retry after a short delay (toast.js should load soon)
    setTimeout(() => {
      if (typeof window.showToast === 'function') window.showToast(msg, type, duration);
    }, 500);
  }
}

function buildErrorMessage(provider, error) {
  let msg = "Erreur lors de la connexion " + provider;
  if (error.code === 'auth/unauthorized-domain') {
    msg += "\n\nCe domaine n'est pas autorisé dans la console Firebase. Demandez à l'administrateur d'ajouter ce domaine dans Authentication > Settings > Authorized domains.";
  } else if (error.code === 'auth/operation-not-allowed') {
    msg += "\n\nLa connexion " + provider + " n'est pas activée dans la console Firebase (Authentication > Sign-in method).";
  } else if (error.code === 'auth/account-exists-with-different-credential') {
    msg += "\n\nUn compte existe déjà avec cette adresse email via un autre fournisseur. Connectez-vous avec ce même fournisseur pour accéder à votre compte existant.";
  } else if (error.code === 'auth/popup-closed-by-user') {
    msg += "\n\nLa fenêtre de connexion a été fermée avant la fin. Réessayez.";
  } else if (error.code === 'auth/cancelled-popup-request') {
    msg = ""; // silent
  } else if (error.code === 'auth/popup-blocked') {
    msg += "\n\nLe popup a été bloqué par le navigateur. Utilisation de la redirection à la place...";
  } else if (error.code === 'auth/redirect-operation-pending') {
    msg = ""; // silent — redirect already in progress
  } else if (error.code === 'auth/network-request-failed') {
    msg += "\n\nErreur réseau. Vérifiez votre connexion internet et réessayez.";
  } else {
    msg += " : " + (error.message || error.code);
  }
  return msg;
}

// Handle redirect result on page load (after signInWithRedirect brings user back)
getRedirectResult(auth).then((result) => {
  if (result && result.user) {
    console.log("[auth] Redirect sign-in successful:", result.user.displayName || result.user.email);
    safeShowToast("Connexion réussie !", "success", 3000);
  }
}).catch((error) => {
  console.error("[auth] Redirect result error:", error);
  const msg = buildErrorMessage("redirect", error);
  if (msg) safeShowToast(msg, "error", 6000);
});

// Login function with popup → redirect fallback
async function loginWithProvider(provider, providerName, providerInstance) {
  console.log("[auth] Starting " + providerName + " login (popup mode)...");
  try {
    const result = await signInWithPopup(auth, providerInstance);
    console.log("[auth] Popup sign-in successful:", result.user.displayName || result.user.email);
    return result.user;
  } catch (error) {
    console.error("[auth] Popup " + providerName + " failed:", error.code, error.message);

    // If popup blocked or unauthorized domain, fallback to redirect (more robust)
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/cancelled-popup-request') {
      console.log("[auth] Falling back to redirect mode for " + providerName + "...");
      safeShowToast("Redirection vers " + providerName + "...", "info", 2000);
      try {
        await signInWithRedirect(auth, providerInstance);
        // Page will redirect — function won't return here
        return null;
      } catch (redirectError) {
        console.error("[auth] Redirect " + providerName + " also failed:", redirectError);
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

window.loginWithGoogle = async () => {
  return loginWithProvider("Google", "Google", googleProvider);
};

window.loginWithDiscord = async () => {
  return loginWithProvider("Discord", "Discord", discordProvider);
};

window.logout = () => signOut(auth);
