import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  GithubAuthProvider,
  OAuthProvider,
  signOut, 
  onAuthStateChanged 
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
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./shared/firebase-config.js"; 

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Providers
const googleProvider = new GoogleAuthProvider();
const discordProvider = new OAuthProvider('oidc.discord');

export {
  auth, db, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, onSnapshot, increment, deleteField,
  googleProvider, discordProvider, signInWithPopup, signOut, onAuthStateChanged,
};

window.loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Erreur Google Login:", error);
    let msg = "Erreur lors de la connexion Google";
    if (error.code === 'auth/unauthorized-domain') {
      msg += "\n\nDomaine non autorisé. Veuillez ajouter 'skailex239.github.io' dans la console Firebase (Authentification > Paramètres > Domaines autorisés).";
    } else if (error.code === 'auth/operation-not-allowed') {
      msg += "\n\nLa connexion Google n'est pas activée dans votre console Firebase.";
    } else {
      msg += ": " + (error.message || error.code);
    }
    showToast(msg, "error", 6000);
  }
};

window.loginWithDiscord = async () => {
  try {
    const result = await signInWithPopup(auth, discordProvider);
    return result.user;
  } catch (error) {
    console.error("Erreur Discord Login:", error);
    let msg = "Erreur lors de la connexion Discord";
    if (error.code === 'auth/unauthorized-domain') {
      msg += "\n\nDomaine non autorisé dans la console Firebase. Ajoutez votre domaine dans Authentification > Paramètres > Domaines autorisés.";
    } else if (error.code === 'auth/operation-not-allowed') {
      msg += "\n\nLa connexion Discord n'est pas activée. Vérifiez la configuration dans Firebase Console > Authentication > Sign-in method > Discord.";
    } else if (error.code === 'auth/account-exists-with-different-credential') {
      msg += "\n\nUn compte existe déjà avec cette adresse email via un autre fournisseur (Google?). Connectez-vous avec ce fournisseur puis liez Discord dans votre profil.";
    } else {
      msg += ": " + (error.message || error.code);
    }
    showToast(msg, "error", 6000);
  }
};

window.logout = () => signOut(auth);
