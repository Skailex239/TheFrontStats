import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
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

// L15: Explicit persistence — keep user logged in across browser sessions
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

// L14: Generic domain message (no hardcoded domain name)
function buildErrorMessage(provider, error) {
  let msg = "Erreur lors de la connexion " + provider;
  if (error.code === 'auth/unauthorized-domain') {
    msg += "\n\nCe domaine n'est pas autorisé dans la console Firebase. Demandez à l'administrateur d'ajouter ce domaine dans Authentication > Settings > Authorized domains.";
  } else if (error.code === 'auth/operation-not-allowed') {
    msg += "\n\nLa connexion " + provider + " n'est pas activée dans la console Firebase (Authentication > Sign-in method).";
  } else if (error.code === 'auth/account-exists-with-different-credential') {
    // L13: Fixed misleading message — no UI to link accounts exists yet
    msg += "\n\nUn compte existe déjà avec cette adresse email via un autre fournisseur. Connectez-vous avec ce même fournisseur pour accéder à votre compte existant.";
  } else if (error.code === 'auth/popup-closed-by-user') {
    msg += "\n\nLa fenêtre de connexion a été fermée avant la fin. Réessayez.";
  } else if (error.code === 'auth/cancelled-popup-request') {
    msg = ""; // silent — user opened a second popup, ignore
  } else if (error.code === 'auth/popup-blocked') {
    msg += "\n\nLe popup a été bloqué par le navigateur. Autorisez les popups pour ce site.";
  } else {
    msg += " : " + (error.message || error.code);
  }
  return msg;
}

// L2: login functions now THROW the error after showing the toast
// so handleLogin in app.js can catch it and reset the UI state
window.loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Erreur Google Login:", error);
    const msg = buildErrorMessage("Google", error);
    if (msg) showToast(msg, "error", 6000);
    throw error; // L2: re-throw so caller knows it failed
  }
};

window.loginWithDiscord = async () => {
  try {
    const result = await signInWithPopup(auth, discordProvider);
    return result.user;
  } catch (error) {
    console.error("Erreur Discord Login:", error);
    const msg = buildErrorMessage("Discord", error);
    if (msg) showToast(msg, "error", 6000);
    throw error; // L2: re-throw so caller knows it failed
  }
};

window.logout = () => signOut(auth);
