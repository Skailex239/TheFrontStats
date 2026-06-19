import { MAP_NORMALIZATION } from "./shared/maps.js";

function getMapDisplayName(mapName) {
  const key = "map." + mapName;
  const translated = window.t ? window.t(key) : key;
  return translated === key ? mapName : translated;
}

let allRuns=[],allMaps=[],activeMap=null,playerStats={},globalLeaderboard=[],mapShowCount=[],comparePlayers=[],previousGlobalLeaderboard=[];
let _rawRuns=[]; // Données brutes complètes — jamais trimmées, pour re-process complet
let _recentRuns=[]; // Top runs récents pour le feed
let _latestRun=null; // Run la plus récente
let _mapTotalCounts={}; // Comptes totaux par map (pour chart)
let _durationBuckets={}; // Distribution durées (pour chart)
const TOP_PER_MAP=25;
let currentMode = 'normal'; // 'normal' or 'compact'
let gameCommit = null;
let lastSyncTime = null;
let aliasMap = {}; // Fusion temps réel via loadPublicAliases() (Firestore)
// Color picker removed — orange/yellow gradient theme is now default
const RANKS=[{name:'Champion',min:100,icon:'👑',color:'#f0c060'},{name:'Diamond',min:50,icon:'💎',color:'#b9f2ff'},{name:'Gold',min:25,icon:'🥇',color:'#f0c060'},{name:'Silver',min:10,icon:'🥈',color:'#a0b0c4'},{name:'Bronze',min:3,icon:'🥉',color:'#c08840'},{name:'Unranked',min:0,icon:'⬜',color:'#555568'}];
function getRank(pts){return RANKS.find(r=>pts>=r.min)||RANKS[RANKS.length-1]}
// Theme functions removed — orange/yellow gradient is the fixed theme

function animateRanking(){
  const leaderboard = document.getElementById("global-list");
  if(!leaderboard) return;
  const rows = leaderboard.getElementsByTagName("tr");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rank = parseInt(row.getElementsByTagName("td")[0].textContent);
    const player = row.getElementsByTagName("td")[1].textContent;
    const points = row.getElementsByTagName("td")[2].textContent;
    const prevRank = previousGlobalLeaderboard.find(p => p.player === player);
    if (prevRank && prevRank.rank !== rank) {
      row.classList.add("animate");
      setTimeout(() => row.classList.remove("animate"), 2000);
    }
  }
}
function createConfetti(){}
function formatTime(s){const m=Math.floor(s/60);return m+":"+String(s%60).padStart(2,"0")}
function formatDate(iso){return new Date(iso).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit"})}
function getRunUrl(r){return r.url||("https://openfront.io/game/"+r.id)}
// Échappement XSS-safe : convertit les caractères dangereux en entités HTML
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function playSound(){}
function notifyNewRecord(msg){if(Notification.permission==='granted'){new Notification('TheFrontStats',{body:msg,icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text y="32" font-size="32">🏆</text></svg>'});playSound()}}
function requestNotifs(){if('Notification' in window)Notification.requestPermission()}

/* ====== AUTH LOGIC ====== */
let currentUser = null;
let playerClientIds = new Set(); // IDs OpenFront liés au compte connecté
let playerAliases = new Set(); // Anciens pseudonymes trouvés via l'API OpenFront
let playerGameIds = new Set(); // gameIds vérifiés via le public ID (match exact)
let playerSessionMap = new Map(); // gameId → session (pour vérifier hasWon/mode)
let vipPlayers = new Map(); // username → reward type (pour le style VIP sur le leaderboard)
let connectedUsernames = new Set(); // usernames having a registered TheFrontStats account

// Enregistrer les fonctions de navigation IMMÉDIATEMENT pour qu'elles
// soient disponibles même si le reste du module a des erreurs
window.goToProfilePage = function(event) {
  if (event) event.stopPropagation();
  window.location.href = "profile.html";
};
window.toggleAuthModal = function() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.toggle('active');
};

// Écouter les changements d'état d'auth au chargement
import { auth, db, doc, getDoc, getDocs, setDoc, collection, query, where, onSnapshot, updateDoc, increment, onAuthStateChanged } from "./auth.js";

// ====== FIRESTORE REAL-TIME LIKES ======
let globalLikes = {};
let _renderDebounce = null;
function debouncedRender() {
  if (_renderDebounce) return;
  _renderDebounce = setTimeout(() => {
    _renderDebounce = null;
    if (_rawRuns.length > 0) { processData(); renderAll(); }
  }, 300);
}

// S'abonner aux likes en temps réel
onSnapshot(collection(db, "likes"), (snapshot) => {
  snapshot.forEach((changeDoc) => {
    globalLikes[changeDoc.id] = changeDoc.data();
  });
  // Rafraîchir l'affichage de la carte active si nécessaire
  if (activeMap) {
    const d = allMaps.find(m => m.map === activeMap);
    if (d) renderLeaderboard(d);
  }
}, (error) => {
  console.warn("[app] Firestore likes listener error (non-critique):", error.message);
});

onAuthStateChanged(auth, async (user) => {
  // L9: redirectToProfileIfRequested() is called once at module load (line ~1452), not here
  if (user) {
    // Vérifier si le profil existe déjà dans Firestore
    let userDoc;
    try {
      userDoc = await getDoc(doc(db, "users", user.uid));
    } catch (e) {
      console.warn("[auth] Firestore read failed:", e.message);
      userDoc = { exists: () => false, data: () => null };
    }

    // Fresh-login redirect: if the user just logged in (sessionStorage flag set
    // by handleLogin BEFORE the login call) AND has a profile with publicId,
    // send them straight to profile.html to see their stats.
    let justLoggedIn = false;
    try { justLoggedIn = sessionStorage.getItem("tfs_just_logged_in") === "1"; } catch {}
    if (justLoggedIn) {
      try { sessionStorage.removeItem("tfs_just_logged_in"); } catch {}
      const data = userDoc.exists() ? userDoc.data() : null;
      if (data && data.publicId) {
        console.log("[auth] Login réussi — redirection vers profile.html");
        if (typeof showToast === 'function') {
          showToast("Bienvenue " + (data.username || '') + " ! Redirection...", "success", 1500);
        }
        setTimeout(() => { window.location.href = "profile.html"; }, 800);
        return;
      }
      // No profile yet → stay on index.html and show setup modal below
    }

    if (userDoc.exists()) {
      const userData = userDoc.data();
      currentUser = {
        name: userData.username,
        publicId: userData.publicId,
        avatar: user.photoURL,
        uid: user.uid
      };

      // Récupérer les Client IDs et les pseudos historiques depuis l'API OpenFront
      await fetchPlayerClientIds(userData.publicId, userData.openFrontSessions);

      updateAuthUI(currentUser);
      processData(); // Re-traiter les données pour appliquer la fusion
      renderAll();
      console.log("Profil chargé et fusionné:", currentUser.name);
    } else {
      // Premier login : on demande les infos
      currentUser = {
        uid: user.uid,
        avatar: user.photoURL,
        email: user.email
      };
      updateAuthUI({ name: user.displayName || 'Joueur', avatar: user.photoURL, uid: user.uid });
      showProfileModal();
    }
  } else {
    currentUser = null;
    playerClientIds = new Set();
    playerAliases = new Set();
    playerGameIds = new Set();
    playerSessionMap = new Map();
    updateAuthUI(null);
    processData();
    renderAll();
    console.log("Utilisateur déconnecté");
  }
});

async function fetchPlayerClientIds(publicId, cachedSessions) {
  if (Array.isArray(cachedSessions) && cachedSessions.length) {
    playerClientIds = new Set(cachedSessions.map((s) => s.clientId).filter(Boolean));
    playerAliases = new Set(cachedSessions.map((s) => s.username).filter(Boolean));
    playerGameIds = new Set(cachedSessions.map((s) => s.gameId || s.game || s.id).filter(Boolean));
    // Construire la map gameId → session pour vérifier hasWon/mode au matching
    playerSessionMap = new Map();
    cachedSessions.forEach((s) => {
      const gid = s.gameId || s.game || s.id;
      if (gid) playerSessionMap.set(gid, s);
    });
    console.log(`${playerClientIds.size} Client IDs, ${playerGameIds.size} gameIds pour ${publicId}`);
    return;
  }
  playerClientIds = new Set();
  playerAliases = new Set();
  playerGameIds = new Set();
  playerSessionMap = new Map();
}

/**
 * Charge les joueurs VIP depuis Firestore (collection public-rewards)
 * Ces données sont publiques et servent à afficher le style VIP sur le leaderboard
 */
async function loadVipPlayers() {
  try {
    // Listener temps réel sur public-rewards pour que les toggles cosmétiques
    // se reflètent instantanément sur le leaderboard de tout le monde
    onSnapshot(collection(db, "public-rewards"), (snap) => {
      vipPlayers = new Map();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        // Nouveau format: activeType (cosmétique sélectionné)
        // Ancien format: type (rétrocompatibilité)
        const rewardType = data.activeType || data.type || null;
        // Seulement les joueurs dont le cosmétique est activé et ont un type actif
        if (data.username && rewardType && data.activated !== false) {
          vipPlayers.set(data.username, rewardType);
          connectedUsernames.add(data.username);
        }
      });
      // Re-render si on a déjà des données (debounced)
      if (_rawRuns.length > 0) {
        debouncedRender();
      }
    }, (error) => {
      console.warn("[app] Firestore VIP listener error (non-critique):", error.message);
      vipPlayers = new Map();
    });
  } catch (e) {
    console.warn("[app] Erreur chargement VIP:", e);
    vipPlayers = new Map();
  }
}

// ====== PUBLIC ALIASES — Fusion pour TOUS les viewers ======
// Charge la collection public-aliases (écrite par profile.js quand un user se connecte)
// et enrichit aliasMap pour que la fusion de pseudos soit visible par tout le monde
let publicAliasesLoaded = false;
function loadPublicAliases() {
  try {
    onSnapshot(collection(db, "public-aliases"), (snap) => {
      let changed = false;
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (!data.username || !data.aliases || data.aliases.length <= 1) return;

        const pid = '__public_alias__' + docSnap.id;
        const existing = aliasMap[pid];
        const newAliases = JSON.stringify(data.aliases || []);

        // Détecter un VRAI changement (comparaison sérialisée)
        if (existing && existing._raw === newAliases) return;

        if (data.clientIds) {
          data.clientIds.forEach(cid => {
            if (cid && !data.aliases.includes(cid)) {
              if (aliasMap[cid] && aliasMap[cid].name !== data.username) {
                aliasMap[cid] = { name: data.username, aliases: aliasMap[cid].aliases || [] };
              } else if (!aliasMap[cid]) {
                aliasMap[cid] = { name: data.username, aliases: [] };
              }
            }
          });
        }

        aliasMap[pid] = { name: data.username, aliases: data.aliases || [], _raw: newAliases };
        connectedUsernames.add(data.username);
        changed = true;
      });

      if (changed && _rawRuns.length > 0) {
        debouncedRender();
      }
      publicAliasesLoaded = true;
    }, (error) => {
      console.warn("[app] Firestore public-aliases listener error (non-critique):", error.message);
    });
  } catch (e) {
    console.warn("[app] Erreur chargement public-aliases:", e);
  }
}

function showProfileModal() {
  document.getElementById('profile-modal').classList.add('active');
}
function closeProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (modal) modal.classList.remove('active');
}
window.closeProfileModal = closeProfileModal;

// L7: Ownership verification state
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;

// L7+L8: Step 1 — validate format, check API existence, generate challenge code
window.startOwnershipVerification = async () => {
  const username = document.getElementById('profile-username').value.trim();
  const publicId = document.getElementById('profile-public-id').value.trim();

  // L8: Form validation
  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  // L8: OpenFront publicId is exactly 8 alphanumeric chars
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast("Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -", "warning");
    return;
  }

  // L8: Check that publicId is not already linked to another account
  try {
    const existing = (await getDoc(doc(db, "users", currentUser.uid))).data() || {};
    if (existing.publicId && existing.publicId !== publicId) {
      showToast("Le Public ID OpenFront ne peut plus être modifié.", "error");
      return;
    }
  } catch (e) {
    console.warn("[ownership] Could not check existing profile:", e.message);
  }

  // L8: Verify publicId exists via OpenFront API
  showToast("Vérification du Public ID...", "info", 3000);
  try {
    const { fetchOpenFront } = await import('./openfront-client.js');
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.games) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
  } catch (e) {
    showToast("Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.", "error");
    console.error("[ownership] API check failed:", e);
    return;
  }

  // L7: Generate challenge code
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  _ownershipCode = "TFS-";
  for (let i = 0; i < 4; i++) _ownershipCode += chars[Math.floor(Math.random() * chars.length)];
  _ownershipPublicId = publicId;
  _ownershipUsername = username;

  // Show step 2
  document.getElementById('profile-setup-step1').style.display = 'none';
  document.getElementById('profile-setup-step2').style.display = 'block';
  document.getElementById('ownership-code').textContent = _ownershipCode;
  document.getElementById('ownership-example').textContent = _ownershipCode + " " + username;
  showToast("Code généré. Suivez les instructions ci-dessous.", "info");
};

// L7: Step 2 — confirm by checking that the code appears in recent sessions
window.confirmOwnershipVerification = async () => {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById('confirm-ownership-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Vérification...";

  try {
    const { fetchOpenFront } = await import('./openfront-client.js');
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}`);

    // L7: Search for the challenge code in recent game usernames
    const games = playerData.games || [];
    let found = false;
    for (const g of games) {
      if (g.username && g.username.includes(_ownershipCode)) {
        found = true;
        break;
      }
    }
    // Also check the main username field
    if (!found && playerData.user && playerData.user.username && playerData.user.username.includes(_ownershipCode)) {
      found = true;
    }

    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Assurez-vous d'avoir joué avec le code dans votre pseudo.", "error", 6000);
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }

    // L7: Verification successful — save profile
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
};

// L7: Cancel — back to step 1
window.cancelOwnershipVerification = () => {
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  document.getElementById('profile-setup-step1').style.display = 'block';
  document.getElementById('profile-setup-step2').style.display = 'none';
};

// L7: Final save (called after ownership verification succeeds)
async function saveUserProfile(username, publicId) {
  try {
    const existing = (await getDoc(doc(db, "users", currentUser.uid))).data() || {};
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email,
      verified: true, // L7: mark as ownership-verified
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openFrontSyncPending: true,
    }, { merge: true });

    currentUser.name = username;
    currentUser.publicId = publicId;

    await fetchPlayerClientIds(publicId, []);

    document.getElementById('profile-modal').classList.remove('active');
    // Reset to step 1 for next time
    window.cancelOwnershipVerification();
    updateAuthUI(currentUser);
    processData();
    renderAll();
    showToast("Profil vérifié et enregistré avec succès ! Redirection…", "success");
    // Redirect to profile.html so user can see their freshly-linked stats
    setTimeout(() => { window.location.href = "profile.html"; }, 800);
  } catch (error) {
    console.error("Erreur sauvegarde profil:", error);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
  }
}

function toggleAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.toggle('active');
}

// L11: Track in-progress login to prevent double-clicks
let _loginInProgress = false;

async function handleLogin(provider) {
  if (_loginInProgress) return; // prevent multiple concurrent logins
  _loginInProgress = true;
  console.log(`Tentative de connexion avec ${provider}...`);

  // Simple disable (no innerHTML swap — keeps button content stable)
  const authBtns = document.querySelectorAll('.auth-btn');
  authBtns.forEach(btn => { btn.disabled = true; btn.style.opacity = '0.6'; });

  // Set flag BEFORE login attempt — onAuthStateChanged may fire before
  // signInWithPopup resolves (race condition), so the flag must be ready
  try { sessionStorage.setItem("tfs_just_logged_in", "1"); } catch {}

  try {
    let user;
    if (provider === 'google') {
      user = await window.loginWithGoogle();
    } else if (provider === 'discord') {
      user = await window.loginWithDiscord();
    }

    if (user) {
      toggleAuthModal();
    }
    // L'UI sera mise à jour automatiquement par onAuthStateChanged
  } catch (error) {
    // Login failed — clear the flag so it doesn't trigger a false redirect
    try { sessionStorage.removeItem("tfs_just_logged_in"); } catch {}
    console.error("Erreur d'authentification:", error);
  } finally {
    _loginInProgress = false;
    authBtns.forEach(btn => { btn.disabled = false; btn.style.opacity = ''; });
  }
}

function updateAuthUI(user) {
  const loginBtnMain = document.getElementById('login-btn-main');
  const userContainer = document.getElementById('user-container');
  
  if (user) {
    if (loginBtnMain) loginBtnMain.style.display = 'none';
    if (userContainer) {
      userContainer.style.display = 'block';
      
      const userDisplayName = document.getElementById('user-display-name');
      const dropdownUsernameDisplay = document.getElementById('dropdown-username-display');
      const dropdownPublicidDisplay = document.getElementById('dropdown-publicid-display');
      const dropdownAvatar = document.getElementById('dropdown-avatar');
      
      if (userDisplayName) userDisplayName.textContent = user.name || 'User';
      if (dropdownUsernameDisplay) dropdownUsernameDisplay.textContent = user.name || 'User';
      if (dropdownPublicidDisplay) dropdownPublicidDisplay.textContent = user.publicId || 'No ID';
      
      if (dropdownAvatar) {
        if (user.avatar) {
          dropdownAvatar.innerHTML = '<img src="' + esc(user.avatar) + '" alt="' + esc(user.name) + '" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">';
        } else {
          const initials = (user.name || 'U').substring(0, 2).toUpperCase();
          dropdownAvatar.textContent = initials;
          dropdownAvatar.style.background = 'linear-gradient(135deg, var(--accent), var(--accentL))';
        }
      }
    }
  } else {
    if (loginBtnMain) loginBtnMain.style.display = 'flex';
    if (userContainer) {
      userContainer.style.display = 'none';
      userContainer.classList.remove('open');
    }
    
  }
}

function handleLogout(event) {
  if (event) event.stopPropagation();
  closeUserDropdown();
  if (confirm("Voulez-vous vous déconnecter ?")) {
    window.logout();
    currentUser = null;
    updateAuthUI(null);
  }
}

function toggleUserDropdown(event) {
  if (event) event.stopPropagation();
  const userContainer = document.getElementById('user-container');
  if (userContainer) {
    userContainer.classList.toggle('open');
  }
}

function closeUserDropdown() {
  const userContainer = document.getElementById('user-container');
  if (userContainer) {
    userContainer.classList.remove('open');
  }
}

// Click outside logic to close dropdown
document.addEventListener('click', (e) => {
  const userContainer = document.getElementById('user-container');
  if (userContainer && !userContainer.contains(e.target)) {
    userContainer.classList.remove('open');
  }
});

function goToProfilePage(event) {
  if (event) event.stopPropagation();
  closeUserDropdown();
  window.location.href = "profile.html";
}

function redirectToProfileIfRequested() {
  const tabParam = new URLSearchParams(window.location.search).get("tab");
  if (tabParam === "profile") window.location.replace("profile.html");
}

let refreshInterval=null,prevRunCount=0,totalRunsCount=0;
let _lastETag=null,_processDataCache=null;

function showProgressBar(){const b=document.getElementById('loading-bar');if(b){b.style.opacity='1';b.style.width='0%'}}
function hideProgressBar(){const b=document.getElementById('loading-bar');if(b){b.style.width='100%';setTimeout(()=>{b.style.opacity='0'},400)}}
function setProgressBar(pct){const b=document.getElementById('loading-bar');if(b)b.style.width=pct+'%'}

function debounce(fn,ms){let t;return function(...a){clearTimeout(t);t=setTimeout(()=>fn.apply(this,a),ms)}}

function getDataFile() {
  return currentMode === 'compact' ? 'runs_compact_public.json' : 'runs_public.json';
}
function getDataFileGz() {
  return currentMode === 'compact' ? 'runs_compact_public.json.gz' : 'runs_public.json.gz';
}
// Fallback to full files if public payload doesn't exist
function getDataFileFallback() {
  return currentMode === 'compact' ? 'runs_compact.json' : 'runs.json';
}
function getDataFileGzFallback() {
  return currentMode === 'compact' ? 'runs_compact.json.gz' : 'runs.json.gz';
}

/** Decode compact array-of-arrays format into standard object format */
function decodeCompactPayload(data) {
  if (data.k && data.r && Array.isArray(data.r) && Array.isArray(data.r[0])) {
    console.log('[TheFrontStats] 📦 Décompactage du format optimisé...');
    const keys = data.k;
    const runs = data.r.map(row => {
      const obj = {};
      keys.forEach((k, i) => { obj[k] = row[i]; });
      return obj;
    });
    return { runs, totalCount: data.t, lastUpdate: data.u, latestCommit: data.c, mapTotals: data.m || {} };
  }
  return null;
}

function updateSubtitle() {
  const el = document.getElementById('header-subtitle');
  if (!el) return;
  if (currentMode === 'compact') {
    el.textContent = 'Leaderboard FFA · 3+ joueurs · 100 bots · Compact';
  } else {
    el.textContent = 'Leaderboard FFA · 10+ joueurs · 400 bots · Standard';
  }
}

async function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;

  // Update buttons
  document.getElementById('mode-btn-normal').classList.toggle('active', mode === 'normal');
  document.getElementById('mode-btn-compact').classList.toggle('active', mode === 'compact');

  // Loading state
  document.getElementById('mode-selector').classList.add('mode-loading');

  // Update subtitle
  updateSubtitle();

  // Update URL
  const p = new URLSearchParams(window.location.search);
  if (mode === 'compact') p.set('mode', 'compact');
  else p.delete('mode');
  const h = window.location.pathname + (p.toString() ? '?' + p.toString() : '');
  history.replaceState(null, '', h);

  // Reset state
  activeMap = null;
  mapShowCount = [];
  if(refreshInterval) clearInterval(refreshInterval);

  // Reload data
  await loadData();
  document.getElementById('mode-selector').classList.remove('mode-loading');
  console.log(`[TheFrontStats] 🔄 Mode changé: ${mode}`);
}


const localDB = {
  db: null,
  async init() {
    if (!window.indexedDB) return;
    return new Promise((resolve) => {
      const req = indexedDB.open("TheFrontStatsDB", 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("cache");
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = () => resolve();
    });
  },
  async get(key) {
    if (!this.db) return null;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction("cache", "readonly");
        const req = tx.objectStore("cache").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch(e) { resolve(null); }
    });
  },
  async set(key, val) {
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction("cache", "readwrite");
        tx.objectStore("cache").put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch(e) { resolve(); }
    });
  }
};
localDB.init(); // Démarre en arrière-plan

function applyPayloadData(data, isBackground = false) {
  window.apiMapTotals = {};
  let apiMapTotals = window.apiMapTotals;
  const compact = decodeCompactPayload(data);
  if (compact) {
    allRuns = compact.runs;
    _rawRuns = allRuns;
    totalRunsCount = compact.totalCount || allRuns.length;
    gameCommit = compact.latestCommit;
    lastSyncTime = compact.lastUpdate;
    window.apiMapTotals = compact.mapTotals || {};
  } else if (data.runs && Array.isArray(data.runs)) {
    allRuns = data.runs;
    _rawRuns = allRuns;
    totalRunsCount = data.totalCount || allRuns.length;
    gameCommit = data.latestCommit;
    lastSyncTime = data.lastUpdate;
  } else if (Array.isArray(data)) {
    allRuns = data;
    _rawRuns = allRuns;
    totalRunsCount = allRuns.length;
  } else {
    return false;
  }
  
  processData();
  renderAll();
  updateStats();
  
  if (!activeMap && allMaps.length) selectMap(allMaps[0].map);
  
  if (isBackground) {
    const badge = document.getElementById('refresh-badge');
    if(badge) badge.style.display='inline-block';
  }
  return true;
}

async function loadData(){
    const t0=performance.now();
  console.time('loadData');
  const dataFile = getDataFileGz();
  const fallbackGz = getDataFileGzFallback();
  const dataFilePlain = getDataFile();
  const fallbackPlain = getDataFileFallback();
  const modeKey = 'cache_data_' + currentMode;
  
  console.log(`[TheFrontStats] ⏳ Chargement des données (${currentMode})...`);
  showProgressBar();
  setProgressBar(10);
  
  try {
    // 1. Essayer de charger depuis IndexedDB (Instantané)
    const cachedData = await localDB.get(modeKey);
    if (cachedData) {
      console.log('[TheFrontStats] ⚡ Données affichées depuis le cache local !');
      applyPayloadData(cachedData, false);
      setProgressBar(50);
      hideProgressBar();
    }
    
    // 2. Fetch réseau en arrière-plan (sans 'no-store' pour utiliser le cache HTTP 304 du navigateur)
    let runsRes = await fetch(dataFile);
    if (!runsRes.ok) runsRes = await fetch(fallbackGz);
    if (!runsRes.ok) throw new Error("Impossible de récupérer les données");
    
    let data;
    try {
      const ds = new DecompressionStream("gzip");
      const decompressedStream = runsRes.body.pipeThrough(ds);
      data = await new Response(decompressedStream).json();
    } catch(e) {
      const fbRes = await fetch(dataFilePlain);
      data = fbRes.ok ? await fbRes.json() : await (await fetch(fallbackPlain)).json();
    }
    
    // Vérifier si la donnée réseau est plus récente que le cache
    const isNew = !cachedData || (data.u && data.u !== cachedData.u) || (data.lastUpdate && data.lastUpdate !== cachedData.lastUpdate);
                  
    if (isNew) {
      console.log('[TheFrontStats] 🔄 Nouvelles données récupérées depuis le serveur.');
      await localDB.set(modeKey, data);
      applyPayloadData(data, !!cachedData); // Affiche le badge si mis à jour en background
    } else {
      console.log('[TheFrontStats] ✅ Données déjà à jour.');
    }

    if(refreshInterval) clearInterval(refreshInterval);
    refreshInterval=setInterval(autoRefresh, 180000);
    
    hideProgressBar();
    const elapsed=((performance.now()-t0)/1000).toFixed(1);
    console.log(`[TheFrontStats] ✅ Processus terminé en ${elapsed}s`);
    console.timeEnd('loadData');

  } catch(e) {
    console.error("Erreur critique chargement:", e);
    showToast("Mode hors-ligne : données réseau inaccessibles.", "warning", 6000);
    hideProgressBar();
    
    // Si on a pas de cache du tout, on affiche une erreur fatale
    const cachedData = await localDB.get(modeKey);
    if (!cachedData) {
      const modeLabel = currentMode === 'compact' ? 'compact' : 'normal';
      document.getElementById("map-list").innerHTML=`<div class="error">Erreur: ${e.message}<br><small>Aucune donnée ${modeLabel} disponible pour le moment.</small></div>`;
    }
  }
}

async function autoRefresh(){
  try{
    // Utiliser runs_public.json.gz avec ETag pour éviter de re-télécharger si inchangé
    const autoFileGz = getDataFileGz();
    const autoFilePlain = getDataFile();
    const fallbackGz = getDataFileGzFallback();
    const fallbackPlain = getDataFileFallback();
    let data, d;
    try {
      const headers = {};
      if (_lastETag) headers['If-None-Match'] = _lastETag;
      let r = await fetch(autoFileGz, { headers, cache: 'no-store' });
      // Fallback to full files if public payload doesn't exist
      if (!r.ok && r.status === 404) {
        r = await fetch(fallbackGz, { cache: 'no-store' });
      }
      if (r.status === 304) {
        return; // Pas de changement — silent
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const etag = r.headers.get('ETag');
      if (etag) _lastETag = etag;
      const ds = new DecompressionStream("gzip");
      const decompressed = r.body.pipeThrough(ds);
      data = await new Response(decompressed).json();
    } catch(e) {
      // Fallback sur fichier non compressé
      let r = await fetch(autoFilePlain, { cache: 'no-store' });
      if (!r.ok) {
        r = await fetch(fallbackPlain, { cache: 'no-store' });
      }
      if(!r.ok) return;
      data = await r.json();
    }

    // Decode compact format if present
    const compact = decodeCompactPayload(data);
    if (compact) {
      d = compact.runs;
      data = { runs: compact.runs, totalCount: compact.totalCount, latestCommit: compact.latestCommit, lastUpdate: compact.lastUpdate };
    } else {
      d = (data.runs && Array.isArray(data.runs)) ? data.runs : (Array.isArray(data) ? data : null);
    }
    
    if(!d) return;

    if(d.length !== totalRunsCount){
      const newRuns = d.length - totalRunsCount;
      allRuns = d;
      _rawRuns = d;
      totalRunsCount = data.totalCount || allRuns.length;
      gameCommit = data.latestCommit;
      lastSyncTime = data.lastUpdate;
      processData();
      renderAll();
      updateStats();
      
      const badge = document.getElementById('refresh-badge');
      if(badge) {
        badge.style.display='inline-block';
        setTimeout(()=>badge.style.display='none',5000);
      }
      
      console.log(`[TheFrontStats] ✅ Sync: ${newRuns > 0 ? '+'+newRuns+' nouveaux runs' : 'données mises à jour'} (total: ${totalRunsCount})`);
      
      if(newRuns > 0){
        const latest = _latestRun || allRuns[0];
        
        // Confetti for new WR
        const mapData=allMaps.find(m=>m.map===latest.map);
        const rank=mapData?mapData.runs.findIndex(x=>x.id===latest.id)+1:0;
        if(rank===1) createConfetti();

        if(latest && Notification.permission==='granted'){
          notifyNewRecord(latest.player+' a gagné sur '+latest.map+' !');
        }
      }
    } else {
      // même nombre de runs — silent
    }
  }catch(e){
    console.error("[TheFrontStats] ❌ Erreur auto-refresh:", e);
    showToast("Erreur de synchronisation automatique", "warning", 3000);
  }
}

// Re-sync quand l'onglet redevient visible (throttled: max 1x/30s)
let _lastVisibilitySync = 0;
document.addEventListener('visibilitychange', () => {
  if(!document.hidden && _rawRuns.length > 0){
    const now = Date.now();
    if (now - _lastVisibilitySync > 30000) {
      _lastVisibilitySync = now;
      autoRefresh();
    }
  }
});

function processData(){
  // Utiliser _rawRuns (données brutes complètes) pour tout le traitement.
  // allRuns est remplacé par _recentRuns en fin de fonction,
  // donc on ne doit JAMAIS l'utiliser ici.
  const src = _rawRuns.length > 0 ? _rawRuns : allRuns;

  // Normaliser les noms de cartes avant le traitement
  src.forEach(r => {
    if (r.map && MAP_NORMALIZATION[r.map]) {
      r.map = MAP_NORMALIZATION[r.map];
    }
  });
  const ms={};playerStats={};
  
  // Construire un index inversif : pour chaque alias connu, retrouver le playerId
  // Cela permet de fusionner "[LBU] Skailex" et "Skailex" même sans playerId sur la run
  const nameToPlayerId = {};
  for (const [pid, data] of Object.entries(aliasMap)) {
    (data.aliases || []).forEach(alias => { nameToPlayerId[alias] = pid; });
    if (data.name) nameToPlayerId[data.name] = pid;
  }

  // ── FIX: Inject logged-in user's aliases into aliasMap for DETERMINISTIC leaderboard ──
  // This ensures ALL viewers (including non-logged-in friends) see the same merged entries.
  // Previously, isMyFFAWin() merged runs only for the logged-in user, causing rank discrepancies.
  if (currentUser) {
    const virtualPid = '__connected_user__' + currentUser.uid;
    // Collect all known aliases for the logged-in user
    const allMyAliases = new Set([currentUser.name, ...playerAliases]);

    // Pre-scan runs to discover additional aliases/playerIds that belong to this user
    // (runs matched by playerGameIds may have player names or playerIds not in playerAliases)
    src.forEach(r => {
      if (playerGameIds.has(r.id)) {
        const session = playerSessionMap.get(r.id);
        if (session && session.hasWon === false) return; // skip non-wins
        if (r.player) allMyAliases.add(r.player);
      }
    });

    // Create or update the virtual aliasMap entry
    aliasMap[virtualPid] = { name: currentUser.name, aliases: [...allMyAliases] };
    // Map all aliases in the nameToPlayerId index
    allMyAliases.forEach(alias => { nameToPlayerId[alias] = virtualPid; });

    // Also map client IDs that may appear as run.playerId
    playerClientIds.forEach(cid => {
      if (cid && !aliasMap[cid]) {
        aliasMap[cid] = { name: currentUser.name, aliases: [] };
      } else if (cid && aliasMap[cid] && aliasMap[cid].name !== currentUser.name) {
        // Override existing entry — verified API data takes precedence over heuristic aliasMap
        aliasMap[cid] = { name: currentUser.name, aliases: aliasMap[cid].aliases || [] };
      }
      if (cid) nameToPlayerId[cid] = cid;
    });
  }

  // Vérifie si un run appartient au joueur connecté ET que c'est bien une victoire FFA
  // runs.json ne contient que des victoires FFA, donc si on match un run
  // mais que la session API dit hasWon=false, c'est un faux positif
  function isMyFFAWin(run) {
    if (!currentUser) return false;
    if (!playerGameIds.has(run.id)) return false;
    // Vérifier via la session API que c'était bien une victoire
    const session = playerSessionMap.get(run.id);
    if (session && session.hasWon === false) return false; // Perdu = pas dans le leaderboard FFA
    // Si pas de session trouvée ou hasWon=true, on accepte le match
    return true;
  }

  // Fonction pour obtenir le nom canonique d'un joueur
  // ── PRIORITÉ DE MATCHING ──
  // 1. verifiedGameIdMap : gameId vérifié → nom canonique (résout les conflits de pseudos)
  // 2. aliasMap : fusion par playerId ou par nom (index inversé nameToPlayerId)
  // 3. Pseudo brut (fallback)
  function getCanonicalName(run) {
    // aliasMap est enrichie en temps réel par loadPublicAliases() (Firestore)
    // et par les aliases du joueur connecté (via fetchPlayerClientIds)
    // aliasMap : fusion par playerId ou par nom (index inversé nameToPlayerId)
    //    C'est la source unique de vérité — enrichie avec les aliases du joueur connecté
    let pid = run.playerId;
    if (!pid) pid = nameToPlayerId[run.player];
    if (pid && aliasMap[pid]) return aliasMap[pid].name;

    // 2. Fallback : pseudo brut
    return run.player;
  }

  src.forEach(r=>{
    // Fusion globale : utilise getCanonicalName() qui fusionne tous les pseudos par playerId
    const playerName = getCanonicalName(r);
    // _isMe: the run belongs to the logged-in user.
    // Since aliasMap now resolves the user's aliases to currentUser.name,
    // we check the resolved name. We also keep isMyFFAWin() for API-verified runs.
    const isConnectedUserRun = currentUser && playerName === currentUser.name;

    if(!ms[r.map])ms[r.map]={map:r.map,total:0,best:Infinity,runs:[],king:null};
    ms[r.map].total++;
    
    // On clone le run pour ne pas modifier l'original tout en injectant le pseudo fusionné
    const displayRun = { ...r, player: playerName, _isMe: isConnectedUserRun };
    ms[r.map].runs.push(displayRun);
    
    if(r.duration_s < ms[r.map].best) ms[r.map].best = r.duration_s;
    
    if(!playerStats[playerName]) {
      playerStats[playerName] = {
        player: playerName, 
        wins: 0, 
        maps: new Set(), 
        runs: [], 
        totalTime: 0, 
        points: 0, 
        golds: 0, 
        silvers: 0, 
        bronzes: 0, 
        pbs: 0, 
        streak: 0, 
        maxStreak: 0, 
        lastWinDate: null,
        _isMe: isConnectedUserRun
      };
    }
    
    const p = playerStats[playerName];
    const runDate = new Date(r.timestamp).toDateString();
    
    const yesterday=new Date(p.lastWinDate);yesterday.setDate(yesterday.getDate()-1);
    if(p.lastWinDate && yesterday.toDateString() === runDate){
      p.streak++;
    } else if(p.lastWinDate && runDate === p.lastWinDate) {
      // Même jour, on ne change pas la streak
    } else {
      p.streak = 1;
    }
    
    if(runDate !== p.lastWinDate) p.lastWinDate = runDate;
    if(p.streak > p.maxStreak) p.maxStreak = p.streak;
    
    p.wins++;
    p.maps.add(r.map);
    p.runs.push(displayRun);
    p.totalTime += r.duration_s;
  });

  allMaps = Object.values(ms).sort((a,b) => a.map.localeCompare(b.map));
  allMaps.forEach(m => {
    m.runs.sort((a,b) => a.duration_s - b.duration_s);
    if (window.apiMapTotals && window.apiMapTotals[m.map]) {
        m.total = window.apiMapTotals[m.map];
    }
  });
  
  allMaps.forEach(m => {
    m.runs.forEach((r,i) => {
      const p = playerStats[r.player];
      if(!p) return;
      if(i === 0) {
        p.points += 3;
        p.golds++;
        m.king = r.player;
      } else if(i === 1) {
        p.points += 2;
        p.silvers++;
      } else if(i === 2) {
        p.points += 1;
        p.bronzes++;
      }
    });
    
    // PB detection: for each player, track their best on this map
    const playerBests = {};
    m.runs.forEach(r => {
      if(!playerBests[r.player] || r.duration_s < playerBests[r.player]) {
        playerBests[r.player] = r.duration_s;
      }
    });
    m.runs.forEach(r => {
      if(r.duration_s === playerBests[r.player]) r._isPB = true;
      else r._isPB = false;
    });
  });

  // Count PBs per player
  Object.values(playerStats).forEach(p => {
    p.pbs = p.runs.filter(r => r._isPB).length;
  });
  
  globalLeaderboard = Object.values(playerStats).sort((a,b) => b.points - a.points || a.totalTime - b.totalTime);

  // ═════════════════════════════════════════════
  // MEMORY OPTIMIZATION — trim to TOP_PER_MAP per map
  // ═════════════════════════════════════════════
  // 1. Build caches from raw data BEFORE trimming
  _mapTotalCounts = {};
  _durationBuckets = {};
  const bucketSize = 60;
  allMaps.forEach(m => { _mapTotalCounts[m.map] = m.total; });
 src.forEach(r => {
    const b = Math.floor(r.duration_s / bucketSize) * bucketSize;
    const k = formatTime(b);
    _durationBuckets[k] = (_durationBuckets[k] || 0) + 1;
  });

  // 2. Extract top 50 most recent runs for the feed (O(n) min-heap)
  //    Store displayRun clones (with merged player names) instead of raw objects
  //    so the feed shows canonical names, not unmerged ones.
  const feedSrc = src.length <= 50
    ? [...src].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))
    : (() => {
      const k=50;const top=src.slice(0,k);
      for(let i=Math.floor(k/2)-1;i>=0;i--)_heapDown(top,i,k);
      for(let i=k;i<src.length;i++){if(new Date(src[i].timestamp)>new Date(top[0].timestamp)){top[0]=src[i];_heapDown(top,0,k)}}
      return top;
    })();
  // Clone into displayRun objects with canonical names
  const nameToPlayerIdForFeed = (() => {
    const m={};
    for(const [pid,data] of Object.entries(aliasMap)){(data.aliases||[]).forEach(a=>{m[a]=pid});if(data.name)m[data.name]=pid}
    return m;
  })();
  _recentRuns = feedSrc.map(r => {
    let pid=r.playerId;if(!pid)pid=nameToPlayerIdForFeed[r.player];
    const canon=pid&&aliasMap[pid]?aliasMap[pid].name:r.player;
    return {...r,player:canon};
  }).sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
  if (_recentRuns.length > 50) _recentRuns.length = 50;

  _latestRun = _recentRuns[0] || null;

  // 3. Trim each map's leaderboard to TOP_PER_MAP
  allMaps.forEach(m => {
    if (m.runs.length > TOP_PER_MAP) m.runs.length = TOP_PER_MAP;
  });

  // 4. Trim playerStats runs to PBs only
  Object.values(playerStats).forEach(p => {
    const pbMap = {};
    p.runs.forEach(r => {
      if (r._isPB && (!pbMap[r.map] || r.duration_s < pbMap[r.map].duration_s)) pbMap[r.map] = r;
    });
    p.runs = Object.values(pbMap);
  });

  // 5. Replace allRuns with trimmed recent cache
  allRuns = _recentRuns;
  console.log(`[processData] ✂️ Trimmed: ${totalRunsCount} raw → ${_recentRuns.length} feed + ${allMaps.length}×${TOP_PER_MAP} maps en mémoire (src=${src.length})`);
}

function _heapDown(arr, i, size) {
  let smallest = i;
  const left = 2*i+1, right = 2*i+2;
  const ts = new Date(arr[smallest].timestamp).getTime();
  if (left < size && new Date(arr[left].timestamp).getTime() < ts) smallest = left;
  if (right < size && new Date(arr[right].timestamp).getTime() < new Date(arr[smallest].timestamp).getTime()) smallest = right;
  if (smallest !== i) { [arr[i], arr[smallest]] = [arr[smallest], arr[i]]; _heapDown(arr, smallest, size); }
}
function renderAll(){
  renderMaps();
  renderFeed();
  updateStats();
  updateLastUpdate();
  renderGlobal();
  renderHof();
  renderCharts();
  renderCompare();

  // Re-render active map details on language switch
  if (activeMap) {
    const d = allMaps.find(m => m.map === activeMap);
    if (d) {
      document.getElementById("content-title").textContent = getMapDisplayName(activeMap);
      document.getElementById("content-meta").textContent = t("ui.meta", { runs: d.total, best: formatTime(d.best) });
      renderLeaderboard(d);
    }
  }
}
function updateStats(){
  document.getElementById("stat-runs").textContent=totalRunsCount.toLocaleString("fr");
  document.getElementById("stat-maps").textContent=allMaps.length;
  document.getElementById("stat-players").textContent=Object.keys(playerStats).length;
  const bt=allMaps.length?Math.min(...allMaps.map(m=>m.best)):0;
  document.getElementById("stat-best").textContent=bt>0?formatTime(bt):"—";
  const badge=document.getElementById("map-count-badge");
  if(badge)badge.textContent=allMaps.length;
}
function updateLastUpdate(){
  const lang = window.currentLanguage || 'fr';
  const localeStr = lang === 'en' ? 'en-US' : 'fr-FR';

  if(_latestRun){
    const formattedTime = new Date(_latestRun.timestamp).toLocaleString(localeStr);
    document.getElementById("last-update").innerHTML = esc(t("ui.last_update", { time: formattedTime })) + '<span class="refresh-badge" id="refresh-badge" style="display:none">LIVE</span>';
  }

  if (gameCommit) {
    const commitDate = new Date(gameCommit.date).toLocaleDateString(localeStr);
    document.getElementById("game-version").innerHTML = 'Game: <a href="https://github.com/openfrontio/OpenFrontIO/commit/' + esc(gameCommit.sha) + '" target="_blank" style="color:inherit;text-decoration:none">#' + esc(gameCommit.sha.substring(0, 7)) + '</a> (' + esc(commitDate) + ')';
  }
}
function renderMaps(){
  const c=document.getElementById("map-list"),q=document.getElementById("map-search").value.toLowerCase();
  const f=q?allMaps.filter(m=>m.map.toLowerCase().includes(q) || getMapDisplayName(m.map).toLowerCase().includes(q)):allMaps;
  if(!f.length){c.innerHTML='<div class="empty-state"><p>Aucune carte</p></div>';return}
  
  c.innerHTML=f.map(m=>`
      <div class="map-item ${activeMap===m.map?"active":""}" onclick="selectMap('${esc(m.map)}')">
        <span class="map-name">${getMapDisplayName(m.map)}</span>
        <span class="map-count">${m.total}</span>
      </div>
    `).join("");
}
function filterMaps(){renderMaps()}
function selectMap(name){
  activeMap=name;mapShowCount[name]=10;renderMaps();
  const d=allMaps.find(m=>m.map===name);if(!d)return;

  document.getElementById("content-title").textContent=getMapDisplayName(name);
  document.getElementById("content-meta").textContent=t("ui.meta", { runs: d.total, best: formatTime(d.best) });
  document.getElementById("share-btn").style.display='inline-flex';
  renderLeaderboard(d);updateURL();
}
function renderLeaderboard(d){
  const show=mapShowCount[d.map]||10;const best=d.runs[0]?.duration_s||0;
  const now=Date.now();
  let html=d.runs.slice(0,show).map((r,i)=>{
    const rc=i===0?"gold":i===1?"silver":i===2?"bronze":"";
    const gap=i>0?"+"+formatTime(r.duration_s-best):"";
    const diff=r.difficulty?'<span class="run-diff">'+r.difficulty+'</span>':'';
    const age=now-new Date(r.timestamp).getTime();
    const isNew=age<3600000?'<span class="badge-new" data-i18n="run.new">NEW</span>':'';
    const isMeClass = r._isMe ? 'is-me' : '';
    const rewardType = vipPlayers.get(r.player) || null;
    const isVip = !!rewardType;
    // Nouveaux skins utilisent la classe rgb-{type} au lieu de player-{type}
    const isNewSkinType = ['cyberpunk','sunset','aurore','pastel','gold','volcano','ocean','miami','toxic','chroma','prism'].includes(rewardType);
    const cosmeticClass = isVip ? ` is-${rewardType}` : '';
    const cosmeticNameClass = isVip ? (isNewSkinType ? ` rgb-${rewardType}` : ` player-${rewardType}`) : '';
    // Pas de tag/badge rectangle — juste le dégradé sur le pseudo
    
    // GG Button Logic
    const ggData = globalLikes[r.id];
    const ggCount = ggData ? (ggData.count || 0) : 0;
    const usersMap = ggData ? (ggData.users || {}) : {};
    
    // Vérifier si l'utilisateur connecté actuel a déjà liké cette run
    const isLiked = currentUser && !!usersMap[currentUser.uid];
    const activeClass = isLiked ? 'active' : '';
    
    const ggBtn = `<button class="gg-btn ${activeClass}" onclick="toggleGG('${r.id}', event)" id="gg-btn-${r.id}" title="GG!">
      <svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-9c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
      <span id="gg-count-${r.id}">${ggCount > 0 ? ggCount : ''}</span>
    </button>`;

    return '<div class="run-row '+isMeClass+cosmeticClass+'"><div class="run-rank '+rc+'">'+(i+1)+'</div><div class="run-player'+cosmeticNameClass+'" onclick="showPlayer(\''+esc(r.player)+'\')">'+r.player+diff+isNew+'</div><a class="run-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay">&#9654;</a><div class="run-time">'+formatTime(r.duration_s)+'</div><div class="run-gap">'+gap+'</div>'+ggBtn+'</div>';
  }).join("");
  if(d.runs.length>show)html+='<button class="see-more-btn" onclick="seeMore(\''+esc(d.map)+'\')">Voir plus ('+(d.runs.length-show)+' restants)</button>';
  document.getElementById("leaderboard").innerHTML=html;
}
function seeMore(map){mapShowCount[map]=(mapShowCount[map]||10)+10;const d=allMaps.find(m=>m.map===map);if(d)renderLeaderboard(d)}
function shareMap(){
  if(!activeMap)return;
  const url=window.location.origin+window.location.pathname+'?map='+encodeURIComponent(activeMap);
  const b=document.getElementById('share-btn');
  const origHTML=b.innerHTML;
  navigator.clipboard.writeText(url).then(()=>{b.innerHTML='<span>✓ Copié !</span>';setTimeout(()=>b.innerHTML=origHTML,2000)});
}

async function toggleGG(runId, event) {
  if (event) event.stopPropagation();
  
  if (!currentUser) {
    toggleAuthModal();
    return;
  }
  
  const userId = currentUser.uid;
  const likeRef = doc(db, "likes", runId);
  
  // Lire l'état actuel de globalLikes pour savoir si l'utilisateur a déjà liké
  const ggData = globalLikes[runId] || { count: 0, users: {} };
  const usersMap = ggData.users || {};
  const hasLiked = !!usersMap[userId];
  
  const btn = document.getElementById(`gg-btn-${runId}`);
  const countSpan = document.getElementById(`gg-count-${runId}`);
  
  if (btn && countSpan) {
    let currentCount = parseInt(countSpan.textContent) || 0;
    
    // Effet visuel immédiat (optimiste)
    if (hasLiked) {
      btn.classList.remove('active');
      const newCount = currentCount - 1;
      countSpan.textContent = newCount > 0 ? newCount : '';
    } else {
      btn.classList.remove('active');
      void btn.offsetWidth; // force le reflow pour relancer l'animation
      btn.classList.add('active');
      const newCount = currentCount + 1;
      countSpan.textContent = newCount > 0 ? newCount : '';
    }
  }
  
  // Mise à jour de la base de données Firestore
  try {
    if (hasLiked) {
      // Atomic unlike: decrement count + remove user in a single updateDoc call
      // updateDoc supports increment() and deleteField() atomically, no race condition
      const { deleteField } = await import('./auth.js');
      await updateDoc(likeRef, {
        count: increment(-1),
        ['users.' + userId]: deleteField()
      });
      // Update local cache
      const updatedData = { ...(globalLikes[runId] || { count: 0, users: {} }) };
      delete updatedData.users[userId];
      updatedData.count = Math.max(0, (updatedData.count || 1) - 1);
      globalLikes[runId] = updatedData;
    } else {
      await setDoc(likeRef, {
        count: increment(1),
        users: { [userId]: true }
      }, { merge: true });
    }
  } catch (error) {
    console.error("Erreur lors de l'envoi du like sur Firestore:", error);
    // En cas d'erreur, restaurer l'état réel de globalLikes
    if (activeMap) {
      const d = allMaps.find(m => m.map === activeMap);
      if (d) renderLeaderboard(d);
    }
  }
}

function timeAgo(ts){
  const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(s<60)return t("time.now");
  if(s<3600)return t("time.min", { n: Math.floor(s/60) });
  if(s<86400)return t("time.hour", { n: Math.floor(s/3600) });
  const d=Math.floor(s/86400);
  return t("time.day", { n: d });
}
function renderFeed(){
  const c=document.getElementById("feed-list");
  const recent=_recentRuns.slice(0,10);
  if(!recent.length){c.innerHTML='<div class="empty-state"><p>Aucune victoire</p></div>';return}
  c.innerHTML=recent.map((r,i)=>{
    const mapData=allMaps.find(m=>m.map===r.map);
    const rank=mapData?mapData.runs.findIndex(x=>x.id===r.id)+1:0;
    const isTop3=rank<=3&&rank>0;
    const rankBadge=isTop3?'<span class="feed-rank-badge rank-'+rank+'">#'+rank+'</span>':'';
    const age=Date.now()-new Date(r.timestamp).getTime();
    const isNew=age<3600000?'<span class="badge-new">NEW</span>':'';
    return '<div class="feed-item"><div class="feed-rank">'+(i+1)+'</div><div class="feed-info"><div class="feed-player" onclick="showPlayer(\''+esc(r.player)+'\')">'+r.player+isNew+rankBadge+'</div><div class="feed-map">'+getMapDisplayName(r.map)+' · '+timeAgo(r.timestamp)+'</div></div><div class="feed-time">'+formatTime(r.duration_s)+'</div><a class="feed-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay">&#9654;</a></div>';
  }).join("");
}
function renderGlobal(){
  const c=document.getElementById("global-list");
  if(!c) return; // Sécurité si l'élément n'existe pas
  if(!globalLeaderboard.length){c.innerHTML='<div class="empty-state"><p>Aucun joueur</p></div>';return}
  
  // Animate ranking changes
  if (previousGlobalLeaderboard.length > 0) {
    setTimeout(animateRanking, 100);
  }
  
  // Save current leaderboard for next comparison
  previousGlobalLeaderboard = globalLeaderboard.slice(0,50).map((p,i) => ({player: p.player, rank: i+1}));
  
  c.innerHTML='<table class="global-table"><thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Victoires</th></tr></thead><tbody>'+
    globalLeaderboard.slice(0,50).map((p,i)=>{
      const rc = i===0?'gold':i===1?'silver':i===2?'bronze':'';
      const isMeClass = p._isMe ? 'is-me' : '';
      const rewardType = vipPlayers.get(p.player) || null;
      const isVip = !!rewardType;
      const isNewSkinType = ['cyberpunk','sunset','aurore','pastel','gold','volcano','ocean','miami','toxic','chroma','prism'].includes(rewardType);
      const cosmeticClass = isVip ? ` is-${rewardType}` : '';
      const cosmeticNameClass = isVip ? (isNewSkinType ? ` rgb-${rewardType}` : ` player-${rewardType}`) : '';
      const playerInner = isNewSkinType ? '<span class="global-player'+cosmeticNameClass+'" onclick="showPlayer(\''+esc(p.player)+'\')">'+p.player+'</span>' : '<span class="global-player'+cosmeticNameClass+'" onclick="showPlayer(\''+esc(p.player)+'\')">'+p.player+'</span>';
      return '<tr class="'+isMeClass+cosmeticClass+'"><td class="global-rank '+rc+'">'+(i+1)+'</td><td class="global-player-cell" onclick="showPlayer(\''+esc(p.player)+'\')">'+playerInner+'</td><td class="global-points">'+p.points+'</td><td class="global-wins">'+p.wins+'</td></tr>';
    }).join("")+'</tbody></table>';
}
function renderHof(){
  const c=document.getElementById("hof-list");
  if(globalLeaderboard.length<1){c.innerHTML='<div class="empty-state"><p>Pas encore de joueurs</p></div>';return}
  c.innerHTML=globalLeaderboard.slice(0,3).map((p,i)=>{
    const rank=getRank(p.points);
    return '<div class="hof-card hof-'+(i+1)+'"><div class="hof-name" onclick="showPlayer(\''+esc(p.player)+'\')">'+p.player+'</div><div class="hof-rank" style="color:'+rank.color+'">'+rank.name+'</div><div class="hof-pts">'+p.points+' pts</div><div class="hof-detail">'+p.golds+' 1er · '+p.silvers+' 2e · '+p.bronzes+' 3e</div></div>';
  }).join("");
}
function renderCompare(){
  const c=document.getElementById("compare-list");
  if(comparePlayers.length<2){
    c.innerHTML='<div class="empty-state"><h3>'+t("compare.empty_title")+'</h3><p>'+t("compare.empty_desc")+'</p></div>';
    return;
  }
  const p1=playerStats[comparePlayers[0]],p2=playerStats[comparePlayers[1]];
  if(!p1||!p2){
    c.innerHTML='<div class="empty-state"><p>'+t("search.no_player")+'</p></div>';
    return;
  }
  const r1=getRank(p1.points),r2=getRank(p2.points);
  const rows=[
    {label:t("compare.rank"),v1:r1.name,v2:r2.name},
    {label:t("compare.points"),v1:p1.points,v2:p2.points},
    {label:t("compare.gold"),v1:p1.golds,v2:p2.golds},
    {label:t("compare.silver"),v1:p1.silvers,v2:p2.silvers},
    {label:t("compare.bronze"),v1:p1.bronzes,v2:p2.bronzes},
    {label:t("compare.wins"),v1:p1.wins,v2:p2.wins},
    {label:t("compare.maps"),v1:p1.maps.size,v2:p2.maps.size},
    {label:t("compare.avg_time"),v1:formatTime(Math.round(p1.totalTime/p1.wins)),v2:formatTime(Math.round(p2.totalTime/p2.wins))},
    {label:t("compare.max_streak"),v1:p1.maxStreak,v2:p2.maxStreak}
  ];
  c.innerHTML='<table class="global-table"><thead><tr><th></th><th class="global-player" onclick="showPlayer(\''+esc(p1.player)+'\')">'+p1.player+'</th><th class="global-player" onclick="showPlayer(\''+esc(p2.player)+'\')">'+p2.player+'</th></tr></thead><tbody>'+
    rows.map(r=>'<tr><td class="compare-label">'+r.label+'</td><td class="compare-val">'+r.v1+'</td><td class="compare-val">'+r.v2+'</td></tr>').join("")+
    '</tbody></table>';
}
function addCompare(name){
  if(comparePlayers.includes(name))comparePlayers=comparePlayers.filter(p=>p!==name);
  else if(comparePlayers.length>=2)comparePlayers=[comparePlayers[1],name];
  else comparePlayers.push(name);
  renderCompare();updateCompareInputs();
}
function updateCompareInputs(){
  const i1=document.getElementById('cmp1'),i2=document.getElementById('cmp2');
  if(i1)i1.value=comparePlayers[0]||'';if(i2)i2.value=comparePlayers[1]||'';
}
function searchCompare(id){
  const q=document.getElementById(id).value.toLowerCase().trim();
  const c=document.getElementById(id+'-results');
  if(!q){c.innerHTML='';return}
  const m=globalLeaderboard.filter(p=>p.player.toLowerCase().includes(q)).slice(0,3);
  c.innerHTML=m.map(p=>'<div class="cmp-result" onclick="addCompare(\''+esc(p.player)+'\');document.getElementById(\''+id+'-results\').innerHTML=\'\'">'+p.player+' ('+p.points+' pts)</div>').join("");
}
function renderCharts(){
  renderPopularMaps();
  renderDistChart();
}

function renderPopularMaps(){
  const sortedMaps=Object.entries(_mapTotalCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const maxCount=Math.max(...sortedMaps.map(x=>x[1]),1);
  document.getElementById("popular-maps").innerHTML=sortedMaps.map(([map,count])=>
    '<div class="dist-row"><span class="dist-label">'+getMapDisplayName(map)+'</span><div class="dist-bar" style="width:'+Math.max(4,count/maxCount*200)+'px;height:16px;background:var(--accent)"></div><span class="dist-count">'+count+'</span></div>'
  ).join("");
}

function renderDistChart(){
  const sorted=Object.entries(_durationBuckets).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
  const maxB=Math.max(...sorted.map(x=>x[1]),1);
  document.getElementById("dist-chart").innerHTML=sorted.map(([k,v])=>
    '<div class="dist-row"><span class="dist-label">'+k+'</span><div class="dist-bar" style="width:'+Math.max(4,v/maxB*200)+'px;height:16px"></div><span class="dist-count">'+v+'</span></div>'
  ).join("");
}
function searchPlayer(){
  const q=document.getElementById("player-search").value.toLowerCase().trim();
  const c=document.getElementById("search-results");
  if(!q){c.innerHTML='';return}
  const matches=globalLeaderboard.filter(p=>p.player.toLowerCase().includes(q)).slice(0,5);
  if(!matches.length){
    c.innerHTML='<div class="feed-card" style="padding:16px"><p style="color:var(--text2)">'+t("search.no_player")+'</p></div>';
    return;
  }
  c.innerHTML='<div class="feed-card">'+matches.map(p=>{
    const rank=getRank(p.points);
    const desc = t("search.player_desc", { rank: rank.name, wins: p.wins, maps: p.maps.size });
    return '<div class="feed-item" onclick="showPlayer(\''+esc(p.player)+'\')"><div class="feed-rank">'+p.points+'</div><div class="feed-info"><div class="feed-player">'+p.player+'</div><div class="feed-map">'+desc+'</div></div></div>';
  }).join("")+'</div>';
}
function showPlayer(name){
  const p=playerStats[name];if(!p)return;

  // Check if this player has a registered account and get their publicId
  let targetPublicId = null;
  for (const [pid, data] of Object.entries(aliasMap)) {
    if (data.name === name || (data.aliases || []).includes(name)) {
      targetPublicId = pid;
      break;
    }
  }

  if(connectedUsernames.has(name) || targetPublicId){
    const pidParam = targetPublicId ? `&publicId=${encodeURIComponent(targetPublicId)}` : '';
    window.location.href="profile.html?player="+encodeURIComponent(name) + pidParam;
    return;
  }

  // Not connected — show modal with "non connecté" message
  const rank=getRank(p.points);
  document.getElementById("modal-player-name").innerHTML=esc(name)+' <span class="rank-badge" style="color:'+esc(rank.color)+'">'+esc(rank.name)+'</span>';
  document.getElementById("modal-player-stats").textContent=t("ui.player_stats", { wins: p.wins, maps: p.maps.size, points: p.points });
  document.getElementById("modal-wins").textContent=p.wins;
  document.getElementById("modal-maps").textContent=p.maps.size;
  document.getElementById("modal-avg").textContent=formatTime(Math.round(p.totalTime/p.wins));
  const sortedRuns=[...p.runs].sort((a,b)=>a.duration_s-b.duration_s);
  document.getElementById("modal-runs").innerHTML=sortedRuns.map(r=>{
    const mapData=allMaps.find(m=>m.map===r.map);
    const rank2=mapData?mapData.runs.findIndex(x=>x.id===r.id)+1:0;
    const isPB=r._isPB?'<span class="badge-pb">PB</span>':'';
    
    // Calculate hypothetical ranking on this map
    let hypothRank = '';
    if (rank2 > 1) {
      const betterRuns = mapData ? mapData.runs.filter(run => run.duration_s < r.duration_s).length : 0;
      hypothRank = '<span style="color:var(--text3);font-size:11px;margin-left:8px">' + t("ui.hypoth_rank", { rank: betterRuns + 1 }) + '</span>';
    }
    
    return '<div class="player-run-row"><div class="player-run-map">'+getMapDisplayName(r.map)+'</div><div class="player-run-rank">#'+rank2+'</div><div class="player-run-time">'+formatTime(r.duration_s)+'</div><a class="run-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay" style="width:26px;height:26px;font-size:11px">&#9654;</a></div>';
  }).join("");

  // Show "non connecté" notice
  const existingNotice = document.getElementById("modal-not-connected");
  if(!existingNotice){
    const notice = document.createElement("div");
    notice.id = "modal-not-connected";
    notice.style.cssText = "text-align:center;padding:12px;margin-top:8px;border-radius:8px;background:var(--bg2);color:var(--text3);font-size:13px";
    notice.textContent = "Ce joueur n'est pas encore connecté à un compte TheFrontStats.";
    document.querySelector("#player-modal .modal-section").appendChild(notice);
  }

  document.getElementById("player-modal").classList.add("active");
  updateURL();
}
function closeModal(e){
  if(!e||e.target.id==="player-modal")document.getElementById("player-modal").classList.remove("active");
  updateURL();
}
function switchTab(name,btn){
  if (name === 'ranked') loadRankedLeaderboard(true);
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  
  // Toggle FFA-specific elements visibility
  const serverInfo = document.querySelector('.server-info');
  const ffaStatsGrid = document.getElementById('ffa-stats-grid');
  const rankedStatsGrid = document.getElementById('ranked-stats-grid');
  const topbarSubtitle = document.getElementById('topbar-subtitle');
  if (serverInfo) serverInfo.style.display = name === 'ranked' ? 'none' : '';
  if (ffaStatsGrid) ffaStatsGrid.style.display = name === 'ranked' ? 'none' : '';
  if (rankedStatsGrid) rankedStatsGrid.style.display = name === 'ranked' ? 'grid' : 'none';
  if (topbarSubtitle) topbarSubtitle.style.display = name === 'ranked' ? 'none' : '';
  
  const currentActive = document.querySelector('.tab-content.active');
  if (currentActive) {
    currentActive.style.opacity = '0';
    currentActive.style.transform = 'translateY(-8px)';
    setTimeout(() => {
      currentActive.classList.remove('active');
      currentActive.style.opacity = '';
      currentActive.style.transform = '';
      if (btn) btn.classList.add('active');
      const tabContent = document.getElementById('tab-'+name);
      if (tabContent) tabContent.classList.add('active');
      updateURL();
    }, 150);
  } else {
    if (btn) btn.classList.add('active');
    const tabContent = document.getElementById('tab-'+name);
    if (tabContent) tabContent.classList.add('active');
    updateURL();
  }
}
function updateURL(){
  const p=new URLSearchParams();
  const activeTab=document.querySelector('.tab-btn.active');
  if(activeTab){
    const tabs=['maps','ranked','stats'];
    const idx=[...document.querySelectorAll('.tab-btn')].indexOf(activeTab);
    if(idx>=0&&tabs[idx])p.set('tab',tabs[idx]);
  }
  if(activeMap)p.set('map',activeMap);
  const h=window.location.pathname+(p.toString()?'?'+p:'');
  history.replaceState(null,'',h);
}
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});

// Init — theme/color picker removed, orange/yellow gradient is the fixed theme
const urlParams=new URLSearchParams(window.location.search);
const mapParam=urlParams.get('map');
const tabParam=urlParams.get('tab');
const modeParam=urlParams.get('mode');
if (modeParam === 'compact') {
  currentMode = 'compact';
  updateSubtitle();
}
redirectToProfileIfRequested();
loadData().then(()=>{
  loadVipPlayers(); // Charger les joueurs VIP en parallèle
  loadPublicAliases(); // Charger les aliases publics pour fusion visible par tous
  if(mapParam)selectMap(mapParam);
  if (tabParam === 'profile') {
    window.location.replace('profile.html');
    return;
  }
  if (tabParam) {
    const btns = document.querySelectorAll('.tab-btn');
    const tabs = ['maps', 'ranked', 'stats'];
    const idx = tabs.indexOf(tabParam);
    if (idx >= 0 && btns[idx]) switchTab(tabParam, btns[idx]);
  }
});

// Export functions to window for HTML event handlers (module script = not global by default)
window.requestNotifs = requestNotifs;
window.toggleAuthModal = toggleAuthModal;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.toggleUserDropdown = toggleUserDropdown;
window.switchMode = switchMode;
window.switchTab = switchTab;
window.searchPlayer = searchPlayer;
window.filterMaps = filterMaps;
window.shareMap = shareMap;
window.showPlayer = showPlayer;
window.closeModal = closeModal;
window.selectMap = selectMap;
window.toggleGG = toggleGG;
window.seeMore = seeMore;
window.searchCompare = searchCompare;
window.addCompare = addCompare;
window.setLanguage = setLanguage;
window.renderAll = renderAll;
window.closeUserDropdown = closeUserDropdown;


// ====== RANKED LEADERBOARD ======
async function loadRankedLeaderboard(force = false) {
  const container = document.getElementById('ranked-list');
  if (!container) {
    console.warn('[Ranked] Container #ranked-list introuvable');
    return;
  }
  if (!force && window._rankedLoaded) return;
  
  container.innerHTML = '<tr><td colspan="8" style="padding: 20px; text-align: center; color: var(--text3);">Chargement du classement...</td></tr>';
  
  try {
    console.log('[Ranked] Loading leaderboard...');
    
    let data;
    try {
      const gzRes = await fetch('ranked.json.gz', { cache: 'no-store' });
      if (gzRes.ok) {
        const ds = new DecompressionStream('gzip');
        const decompressed = gzRes.body.pipeThrough(ds);
        data = await new Response(decompressed).json();
      } else {
        throw new Error('gz not available');
      }
    } catch (e) {
      const plainRes = await fetch('ranked.json', { cache: 'no-store' });
      if (!plainRes.ok) throw new Error('Impossible de charger le classement');
      data = await plainRes.json();
    }
    
    let players = [];
    if (data['1v1']) players.push(...data['1v1']);
    
    console.log('[Ranked] Players loaded:', players.length);
    
    if (players.length === 0) {
      container.innerHTML = '<tr><td colspan="8" style="padding: 20px; text-align: center; color: var(--text3);">Aucun joueur classé pour le moment.</td></tr>';
      return;
    }
    
    // Store for filtering
    window._rankedPlayers = players;
    
    // Stats cards
    renderRankedStatsCards(players);
    
    // Timestamp
    const updateEl = document.getElementById('ranked-last-update');
    if (updateEl && data.updatedAt) {
      const d = new Date(data.updatedAt);
      updateEl.textContent = 'Màj : ' + d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    
    // Elo distribution
    renderEloDistribution(players);
    
    // Clan leaderboard
    renderClanLeaderboard(players);
    
    // Render table
    renderRankedTable(players);
    renderMyRank(players);
    renderNewcomersDropouts(data);

    // Initialise le compteur de favoris
    updateFavCounter();

    window._rankedLoaded = true;
    console.log('[Ranked] Tableau rendu avec succès');
    
  } catch (err) {
    console.error("[Ranked] Erreur complète:", err);
    container.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #ef4444;">Erreur lors du chargement du classement.</td></tr>`;
  }
}

function getWinrateColor(wr) {
  if (wr >= 60) return '#10b981';
  if (wr >= 55) return '#34d399';
  if (wr >= 50) return '#fbbf24';
  if (wr >= 45) return '#fb923c';
  return '#ef4444';
}

function renderRankedStatsCards(players) {
  const totalPlayers = players.length;
  const avgElo = Math.round(players.reduce((a, p) => a + p.elo, 0) / totalPlayers);
  const maxElo = Math.max(...players.map(p => p.peakElo || p.elo));
  const totalGames = players.reduce((a, p) => a + p.total, 0);
  
  const el = document.getElementById('ranked-stat-players');
  if (el) el.textContent = totalPlayers.toLocaleString('fr');
  const el2 = document.getElementById('ranked-stat-avgelo');
  if (el2) el2.textContent = avgElo.toLocaleString('fr');
  const el3 = document.getElementById('ranked-stat-peakelo');
  if (el3) el3.textContent = maxElo.toLocaleString('fr');
  const el4 = document.getElementById('ranked-stat-games');
  if (el4) el4.textContent = totalGames.toLocaleString('fr');
}

function renderRankedTable(players) {
  const container = document.getElementById('ranked-list');
  if (!container) return;

  let html = '';
  if (!players || players.length === 0) {
    container.innerHTML = '<tr><td colspan="9" style="padding: 20px; text-align: center; color: var(--text3);">Aucun joueur ne correspond aux filtres.</td></tr>';
    return;
  }

  // Affiche un indicateur si on est en mode "favoris seulement"
  const favOnly = window._rankedFilters && window._rankedFilters.favOnly;

  players.forEach(p => {
    const winrate = p.total > 0 ? ((p.wins / p.total) * 100) : 0;
    const winrateStr = winrate.toFixed(1);
    const wrColor = getWinrateColor(winrate);
    const publicIdParam = p.public_id ? `&publicId=${p.public_id}` : '';

    // Movement arrow
    let moveHtml = '—';
    if (p.movement != null) {
      const m = p.movement;
      if (m > 0) moveHtml = `<span style="color:#10b981;font-weight:700">↑${m}</span>`;
      else if (m < 0) moveHtml = `<span style="color:#ef4444;font-weight:700">↓${Math.abs(m)}</span>`;
      else moveHtml = `<span style="color:var(--muted)">—</span>`;
    }

    // Peak Elo with arrow if different from current
    const peakDiff = (p.peakElo || p.elo) - p.elo;
    const peakHtml = peakDiff > 0
      ? `${p.peakElo || p.elo} <span style="color:var(--gold);font-size:11px">↑${peakDiff}</span>`
      : `${p.peakElo || p.elo}`;

    // Streak badge
    let streakHtml = '—';
    if (p.streak != null && p.streak !== 0) {
      if (p.streak > 0) streakHtml = `<span style="color:#f97316;font-weight:700">🔥${p.streak}</span>`;
      else streakHtml = `<span style="color:#3b82f6;font-weight:700">❄️${Math.abs(p.streak)}</span>`;
    }

    // Favori (étoile cliquable)
    const isFav = isFavorite(p.public_id);
    const favStar = isFav ? '★' : '☆';
    const favClass = isFav ? 'fav-star active' : 'fav-star';
    const favBtn = p.public_id
      ? `<button class="${favClass}" onclick="event.stopPropagation();toggleFavorite('${esc(p.public_id)}','${esc(p.username)}')" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-label="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${favStar}</button>`
      : '';

    html += `
      <tr data-pid="${esc(p.public_id)}" style="border-bottom: 1px solid var(--border); transition: background 0.2s; cursor:pointer;"
          onmouseover="this.style.background='var(--bg2)'"
          onmouseout="this.style.background='transparent'"
          onclick="showRankedPlayerModal('${esc(p.public_id)}', '${esc(p.username)}')">
        <td style="padding: 12px 8px; font-weight: bold; color: ${p.rank <= 3 ? 'var(--accent)' : 'var(--text)'};">#${p.rank}</td>
        <td style="padding: 12px 8px;">
          <div style="display:flex;align-items:center;gap:6px">
            ${favBtn}
            <span style="color: var(--text); text-decoration: none; font-weight: 500;">
              ${p.clanTag ? `<span style="color:var(--text3);font-size:0.9em;margin-right:4px;">[${esc(p.clanTag)}]</span>` : ''}${esc(p.username)}
            </span>
          </div>
        </td>
        <td style="padding: 12px 8px; font-family: 'JetBrains Mono', monospace; color: var(--accent); font-weight: 700;">${p.elo}</td>
        <td style="padding: 12px 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted);">${peakHtml}</td>
        <td style="padding: 12px 8px; font-weight: 700; color: ${wrColor};">${winrateStr}%</td>
        <td style="padding: 12px 8px; color: var(--text2); font-family: 'JetBrains Mono', monospace; font-size: 12px;"><span style="color:#10b981">${p.wins}</span> - <span style="color:#ef4444">${p.losses}</span></td>
        <td style="padding: 12px 8px; color: var(--text3); font-family: 'JetBrains Mono', monospace;">${p.total}</td>
        <td style="padding: 12px 8px; text-align: center; font-size: 12px;">${moveHtml}</td>
        <td style="padding: 12px 8px; text-align: center; font-size: 12px;">${streakHtml}</td>
      </tr>
    `;
  });

  container.innerHTML = html;
}

function renderNewcomersDropouts(data) {
  const newcomers = data.newcomers || [];
  const dropouts = data.dropouts || [];
  
  const newCard = document.getElementById('newcomers-card');
  const dropCard = document.getElementById('dropouts-card');
  const newEl = document.getElementById('ranked-newcomers');
  const dropEl = document.getElementById('ranked-dropouts');
  
  if (newCard) newCard.style.display = newcomers.length ? '' : 'none';
  if (dropCard) dropCard.style.display = dropouts.length ? '' : 'none';
  
  if (newEl) {
    if (newcomers.length === 0) newEl.innerHTML = '<div class="empty-state" style="padding:12px"><p style="font-size:12px;color:var(--muted)">Aucun nouveau cette fois</p></div>';
    else {
      newEl.innerHTML = newcomers.map(n => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light)">
          <span style="font-weight:700;color:var(--accent);min-width:32px">#${n.rank}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${esc(n.username)}</span>
          <span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)">${n.elo}</span>
        </div>
      `).join('');
    }
  }
  
  if (dropEl) {
    if (dropouts.length === 0) dropEl.innerHTML = '<div class="empty-state" style="padding:12px"><p style="font-size:12px;color:var(--muted)">Aucun sortant cette fois</p></div>';
    else {
      dropEl.innerHTML = dropouts.map(d => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light)">
          <span style="font-weight:700;color:var(--text3);min-width:32px">#${d.rank}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.username)}</span>
          <span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)">${d.elo}</span>
        </div>
      `).join('');
    }
  }
}

function renderMyRank(players) {
  const container = document.getElementById('my-ranked-position');
  if (!container) return;
  
  // Check if user is logged in and has a publicId
  if (!currentUser || !currentUser.publicId) {
    container.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)">
        <span>👤</span>
        <span>Connecte-toi et lie ton <b>Public ID OpenFront</b> pour voir ta position dans le classement.</span>
      </div>
    `;
    return;
  }
  
  const myPid = currentUser.publicId;
  const me = players.find(p => p.public_id === myPid);
  
  if (!me) {
    container.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)">
        <span>🌍</span>
        <span>Tu n'es pas dans le <b>Top 100</b> actuel. Continue à grind !</span>
      </div>
    `;
    return;
  }
  
  const winrate = me.total > 0 ? ((me.wins / me.total) * 100).toFixed(1) : 0;
  const wrColor = getWinrateColor(parseFloat(winrate));
  const move = me.movement != null ? (me.movement > 0 ? `↑${me.movement}` : me.movement < 0 ? `↓${Math.abs(me.movement)}` : '—') : '—';
  const moveColor = me.movement > 0 ? '#10b981' : me.movement < 0 ? '#ef4444' : 'var(--muted)';
  
  container.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0">${me.rank}</div>
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          <div style="font-weight:700;font-size:14px;color:var(--text)">${esc(currentUser.name || me.username)}</div>
          <div style="font-size:12px;color:var(--muted)">
            <b style="color:var(--accent)">${me.elo}</b> Elo · 
            <b style="color:${wrColor}">${winrate}%</b> WR · 
            <b style="color:${moveColor}">${move}</b> MV · 
            ${me.wins}V - ${me.losses}D
          </div>
        </div>
      </div>
      <button onclick="scrollToMyRank('${esc(myPid)}')" style="background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity 0.2s;white-space:nowrap" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
        🎯 Me trouver
      </button>
    </div>
  `;
}

function scrollToMyRank(publicId) {
  const rows = document.querySelectorAll('#ranked-list tr[data-pid]');
  let row = null;
  rows.forEach(r => { if (r.getAttribute('data-pid') === publicId) row = r; });
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.style.background = 'var(--bg2)';
  setTimeout(() => { row.style.background = ''; }, 2000);
}

// ====== FILTRES RANKED (top / favoris / recherche floue) ======
window._rankedFilters = window._rankedFilters || { top: 'all', favOnly: false, query: '' };
const FAVS_KEY = 'thefrontstats:favorites:v1';

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveFavorites(list) {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(list)); } catch (e) {}
}

function isFavorite(publicId) {
  if (!publicId) return false;
  return getFavorites().indexOf(publicId) !== -1;
}

function toggleFavorite(publicId, username) {
  if (!publicId) return;
  const list = getFavorites();
  const idx = list.indexOf(publicId);
  if (idx === -1) {
    list.push(publicId);
    try { showToast('⭐ ' + (username || 'Joueur') + ' ajouté aux favoris'); } catch (e) {}
  } else {
    list.splice(idx, 1);
    try { showToast('☆ ' + (username || 'Joueur') + ' retiré des favoris'); } catch (e) {}
  }
  saveFavorites(list);
  updateFavCounter();
  // Re-render pour mettre à jour les étoiles (et filtrer si mode favoris actif)
  applyRankedFilters();
}

function updateFavCounter() {
  const count = getFavorites().length;
  const el = document.getElementById('fav-count');
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

function toggleFavFilter() {
  window._rankedFilters.favOnly = !window._rankedFilters.favOnly;
  const btn = document.getElementById('fav-toggle');
  if (btn) {
    if (window._rankedFilters.favOnly) {
      btn.classList.add('active');
      const star = btn.querySelector('.fav-star');
      if (star) star.textContent = '★';
    } else {
      btn.classList.remove('active');
      const star = btn.querySelector('.fav-star');
      if (star) star.textContent = '☆';
    }
  }
  applyRankedFilters();
}

function setTopFilter(n) {
  window._rankedFilters.top = n;
  document.querySelectorAll('#ranked-toolbar .filter-btn[data-top]').forEach(b => {
    b.classList.toggle('active', String(b.getAttribute('data-top')) === String(n));
  });
  applyRankedFilters();
}

// Normalisation : minuscules + suppression diacritiques (é→e, ñ→n...)
function normalizeStr(s) {
  if (!s) return '';
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Recherche floue par sous-séquence : les lettres de q doivent apparaître
// dans l'ordre dans target. Score = proximité (compactness).
// Retourne -1 si pas de match, sinon un score (plus petit = meilleur).
function fuzzyScore(query, target) {
  if (!query) return 0;
  if (!target) return -1;
  const q = normalizeStr(query);
  const t = normalizeStr(target);
  if (!q) return 0;
  // Match exact (includes) = priorité
  if (t.indexOf(q) !== -1) return 0;
  // Sous-séquence : parcourir target en cherchant chaque char de query dans l'ordre
  let ti = 0, lastMatch = -1, totalGap = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (; ti < t.length; ti++) {
      if (t[ti] === c) { found = ti; ti++; break; }
    }
    if (found === -1) return -1; // char non trouvé → pas de match
    if (lastMatch !== -1) totalGap += (found - lastMatch - 1);
    lastMatch = found;
  }
  // Score = gap total (plus c'est compact, meilleur est le match)
  return 1 + totalGap;
}

function applyRankedFilters() {
  if (!window._rankedPlayers) return;
  const f = window._rankedFilters;
  let players = window._rankedPlayers.slice();

  // 1. Filtre Top N
  if (f.top !== 'all') {
    const n = parseInt(f.top, 10);
    if (!isNaN(n)) players = players.slice(0, n);
  }

  // 2. Filtre favoris
  if (f.favOnly) {
    const favs = new Set(getFavorites());
    players = players.filter(p => favs.has(p.public_id));
  }

  // 3. Recherche floue
  const q = (f.query || '').trim();
  if (q) {
    // Garde les matchs dont le score fuzzy est >= 0 (0 = match exact, >0 = fuzzy)
    const scored = players
      .map(p => {
        const usernameScore = fuzzyScore(q, p.username);
        const clanScore = fuzzyScore(q, p.clanTag);
        const best = Math.min(
          usernameScore === -1 ? Infinity : usernameScore,
          clanScore === -1 ? Infinity : clanScore
        );
        return { p, score: best === Infinity ? -1 : best };
      })
      .filter(x => x.score !== -1)
      .sort((a, b) => a.score - b.score);
    players = scored.map(x => x.p);
  }

  renderRankedTable(players);
}

function filterRanked(query) {
  window._rankedFilters.query = query || '';
  applyRankedFilters();
}

function renderEloDistribution(players) {
  const buckets = {
    '2400+': 0, '2300-2399': 0, '2200-2299': 0,
    '2100-2199': 0, '2000-2099': 0, '<2000': 0
  };
  players.forEach(p => {
    const e = p.elo;
    if (e >= 2400) buckets['2400+']++;
    else if (e >= 2300) buckets['2300-2399']++;
    else if (e >= 2200) buckets['2200-2299']++;
    else if (e >= 2100) buckets['2100-2199']++;
    else if (e >= 2000) buckets['2000-2099']++;
    else buckets['<2000']++;
  });
  
  const max = Math.max(1, ...Object.values(buckets));
  const labels = { '2400+': '2400+', '2300-2399': '2300-2399', '2200-2299': '2200-2299', '2100-2199': '2100-2199', '2000-2099': '2000-2099', '<2000': '<2000' };
  
  let html = '';
  Object.entries(buckets).forEach(([k, v]) => {
    const pct = Math.max(4, (v / max) * 200);
    html += `
      <div class="dist-row">
        <span class="dist-label">${labels[k]}</span>
        <div class="dist-bar" style="width:${pct}px;height:16px;background:var(--accent);opacity:0.75"></div>
        <span class="dist-count">${v}</span>
      </div>
    `;
  });
  
  const el = document.getElementById('ranked-elo-dist');
  if (el) el.innerHTML = html || '<div class="empty-state">Aucune donnée</div>';
}

function renderClanLeaderboard(players) {
  const clans = {};
  players.forEach(p => {
    if (!p.clanTag) return;
    if (!clans[p.clanTag]) clans[p.clanTag] = { tag: p.clanTag, members: 0, totalElo: 0, totalGames: 0 };
    clans[p.clanTag].members++;
    clans[p.clanTag].totalElo += p.elo;
    clans[p.clanTag].totalGames += p.total;
  });
  
  const sorted = Object.values(clans)
    .map(c => ({ ...c, avgElo: Math.round(c.totalElo / c.members) }))
    .filter(c => c.members >= 2)
    .sort((a, b) => b.avgElo - a.avgElo || b.members - a.members)
    .slice(0, 10);
  
  if (sorted.length === 0) {
    const el = document.getElementById('ranked-clan-list');
    if (el) el.innerHTML = '<div class="empty-state" style="padding:20px">Aucun clan représenté</div>';
    return;
  }
  
  let html = '<table style="width:100%;border-collapse:collapse;text-align:left;font-size:14px"><thead><tr style="border-bottom:1px solid var(--border);color:var(--text3)"><th style="padding:10px 8px">#</th><th style="padding:10px 8px">Clan</th><th style="padding:10px 8px">Membres</th><th style="padding:10px 8px">Elo moyen</th><th style="padding:10px 8px">Parties</th></tr></thead><tbody>';
  sorted.forEach((c, i) => {
    html += `
      <tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:10px 8px;font-weight:700;color:${i < 3 ? 'var(--accent)' : 'var(--text)'};">${i + 1}</td>
        <td style="padding:10px 8px;font-weight:600">[${esc(c.tag)}]</td>
        <td style="padding:10px 8px;font-family:JetBrains Mono,monospace">${c.members}</td>
        <td style="padding:10px 8px;font-family:JetBrains Mono,monospace;color:var(--accent);font-weight:700">${c.avgElo}</td>
        <td style="padding:10px 8px;font-family:JetBrains Mono,monospace;color:var(--text3)">${c.totalGames.toLocaleString('fr')}</td>
      </tr>
    `;
  });
  html += '</tbody></table>';
  
  const el = document.getElementById('ranked-clan-list');
  if (el) el.innerHTML = html;
}

async function showRankedPlayerModal(publicId, username) {
  const modal = document.getElementById('ranked-player-modal');
  const nameEl = document.getElementById('ranked-modal-player-name');
  const statsEl = document.getElementById('ranked-modal-player-stats');
  const gamesEl = document.getElementById('ranked-modal-games');
  
  if (nameEl) nameEl.textContent = username;
  if (statsEl) statsEl.textContent = 'Chargement...';
  if (gamesEl) gamesEl.innerHTML = '<div class="loading" style="padding:20px">Chargement...</div>';
  if (modal) modal.classList.add('active');
  
  try {
    // Try to fetch via openfront-client if available, otherwise direct
    let pData;
    try {
      const { fetchOpenFront } = await import('./openfront-client.js');
      pData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    } catch (e) {
      // Fallback direct fetch (will likely fail on GH Pages due to CORS)
      const res = await fetch(`https://api.openfront.io/public/player/${encodeURIComponent(publicId)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      pData = await res.json();
    }
    
    if (!pData || !pData.games) {
      if (statsEl) statsEl.textContent = 'Aucune donnée disponible';
      if (gamesEl) gamesEl.innerHTML = '<div class="empty-state" style="padding:20px"><p>Aucun historique trouvé</p></div>';
      return;
    }
    
    const rankedGames = (pData.games || [])
      .filter(g => g.rankedType === '1v1' || g.mode === '1v1' || g.type === 'Ranked')
      .reverse()
      .slice(0, 10);

    // Compute streak from all ranked games (not just last 10)
    const allRankedGames = (pData.games || [])
      .filter(g => g.rankedType === '1v1' || g.mode === '1v1' || g.type === 'Ranked')
      .sort((a, b) => new Date(b.start || b.end || 0) - new Date(a.start || a.end || 0));
    let streak = 0;
    for (const g of allRankedGames) {
      if (g.hasWon === true) {
        if (streak >= 0) streak++;
        else break;
      } else if (g.hasWon === false) {
        if (streak <= 0) streak--;
        else break;
      } else break;
    }
    const streakText = streak > 0 ? `🔥 Série: ${streak} victoires` : streak < 0 ? `❄️ Série: ${Math.abs(streak)} défaites` : '';
    
    if (statsEl) {
      const wins = rankedGames.filter(g => g.hasWon).length;
      const losses = rankedGames.filter(g => g.hasWon === false).length;
      statsEl.textContent = `${rankedGames.length} parties 1v1 · ${wins}V - ${losses}D${streakText ? ' · ' + streakText : ''}`;
    }
    
    if (rankedGames.length === 0) {
      if (gamesEl) gamesEl.innerHTML = '<div class="empty-state" style="padding:20px"><p>Aucune partie classée 1v1 trouvée</p></div>';
      return;
    }
    
    let html = '';
    for (const g of rankedGames) {
      try {
        let gInfo;
        try {
          const { fetchOpenFront } = await import('./openfront-client.js');
          const gRaw = await fetchOpenFront(`/public/game/${g.gameId}?turns=false`);
          gInfo = gRaw.info || gRaw;
        } catch (e) {
          const res = await fetch(`https://api.openfront.io/public/game/${g.gameId}?turns=false`);
          if (!res.ok) continue;
          const gRaw = await res.json();
          gInfo = gRaw.info || gRaw;
        }
        
        const players = gInfo.players || [];
        const me = players.find(pl => pl.clientID === g.clientId);
        const opponent = players.find(pl => pl.clientID !== g.clientId);
        const won = gInfo.winner && Array.isArray(gInfo.winner) && gInfo.winner[1] === g.clientId;
        
        html += `
          <div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--border-light);transition:background 0.2s" onmouseover="this.style.background='var(--card-hover)'" onmouseout="this.style.background='transparent'">
            <div style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff;background:${won ? '#10b981' : '#ef4444'}">${won ? 'W' : 'L'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:14px;color:var(--text)">vs ${esc(opponent?.username || opponent?.displayName || 'Inconnu')}</div>
              <div style="font-size:12px;color:var(--muted)">${esc(g.map || '—')} · ${g.start ? new Date(g.start).toLocaleDateString('fr-FR') : '—'}</div>
            </div>
            <a href="https://openfront.io/game/${g.gameId}" target="_blank" style="width:28px;height:28px;border-radius:8px;background:var(--bg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);text-decoration:none;font-size:10px;transition:all 0.25s" onmouseover="this.style.background='var(--orange)';this.style.color='#fff'" onmouseout="this.style.background='var(--bg)';this.style.color='var(--muted)'">▶</a>
          </div>
        `;
      } catch (e) {
        console.warn('[Ranked] Erreur fetch game detail:', e);
      }
    }
    
    if (gamesEl) gamesEl.innerHTML = html || '<div class="empty-state" style="padding:20px"><p>Impossible de charger les détails</p></div>';
    
  } catch (err) {
    console.error('[Ranked] Erreur historique:', err);
    if (statsEl) statsEl.textContent = 'Erreur de chargement';
    if (gamesEl) gamesEl.innerHTML = `<div class="empty-state" style="padding:20px"><p style="color:#ef4444">Erreur API (CORS probable). Essayez en local.</p></div>`;
  }
}

function closeRankedModal(e) {
  if (!e || e.target.id === 'ranked-player-modal') {
    const modal = document.getElementById('ranked-player-modal');
    if (modal) modal.classList.remove('active');
  }
}

window.loadRankedLeaderboard = loadRankedLeaderboard;
window.filterRanked = filterRanked;
window.showRankedPlayerModal = showRankedPlayerModal;
window.renderMyRank = renderMyRank;
window.scrollToMyRank = scrollToMyRank;
window.closeRankedModal = closeRankedModal;
window.setTopFilter = setTopFilter;
window.toggleFavFilter = toggleFavFilter;
window.toggleFavorite = toggleFavorite;
window.isFavorite = isFavorite;
