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
  redirectToProfileIfRequested();
  if (user) {
    // Vérifier si le profil existe déjà dans Firestore
    const userDoc = await getDoc(doc(db, "users", user.uid));
    
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

window.saveUserProfile = async () => {
  const username = document.getElementById('profile-username').value.trim();
  const publicId = document.getElementById('profile-public-id').value.trim();

  // Form validation
  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (publicId.length < 3) {
    showToast("Le Public ID doit faire au moins 3 caractères.", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -", "warning");
    return;
  }

  try {
    const existing = (await getDoc(doc(db, "users", currentUser.uid))).data() || {};
    if (existing.publicId && existing.publicId !== publicId) {
      showToast("Le Public ID OpenFront ne peut plus être modifié.", "error");
      return;
    }
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openFrontSyncPending: true,
    }, { merge: true });

    currentUser.name = username;
    currentUser.publicId = publicId;
    
    await fetchPlayerClientIds(publicId, []);
    
    document.getElementById('profile-modal').classList.remove('active');
    updateAuthUI(currentUser);
    processData();
    renderAll();
    showToast("Profil enregistré et fusionné avec succès !", "success");
  } catch (error) {
    console.error("Erreur sauvegarde profil:", error);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
  }
};

function toggleAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.toggle('active');
}

async function handleLogin(provider) {
  console.log(`Tentative de connexion avec ${provider}...`);
  try {
    let user;
    if (provider === 'google') {
      user = await window.loginWithGoogle();
    } else if (provider === 'discord') {
      user = await window.loginWithDiscord();
    }
    
    // Note: L'UI sera mise à jour automatiquement par onAuthStateChanged
    if (user) {
      toggleAuthModal();
    }
  } catch (error) {
    console.error("Erreur d'authentification:", error);
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
    return { runs, totalCount: data.t, lastUpdate: data.u, latestCommit: data.c };
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

async function loadData(){
  const t0=performance.now();
  console.time('loadData');
  const dataFile = getDataFileGz();
  const dataFilePlain = getDataFile();
  const fallbackGz = getDataFileGzFallback();
  const fallbackPlain = getDataFileFallback();
  console.log(`[TheFrontStats] ⏳ Chargement des données (${currentMode})...`);
  showProgressBar();
  try{
    setProgressBar(5);
    let runsRes = await fetch(dataFile, { cache: 'no-store' });

    setProgressBar(15);

    // Fallback to full data files if public payload doesn't exist (old deployment)
    if (!runsRes.ok) {
      console.warn(`[TheFrontStats] ⚠️ ${dataFile} non trouvé, fallback sur ${fallbackGz}`);
      runsRes = await fetch(fallbackGz, { cache: 'no-store' });
    }

    if (!runsRes.ok) {
      throw new Error("Impossible de récupérer les données");
    }

    // Décompression native GZIP (DecompressionStream)
    let data;
    try {
      console.log('[TheFrontStats] 📦 Décompression GZIP...');
      setProgressBar(30);
      const ds = new DecompressionStream("gzip");
      const decompressedStream = runsRes.body.pipeThrough(ds);
      data = await new Response(decompressedStream).json();
    } catch(e) {
      console.warn("[app] Fallback sur fichier non compressé", e);
      const fallbackRes = await fetch(dataFilePlain, { cache: 'no-store' });
      if (!fallbackRes.ok) {
        // Try full file fallback
        const fbRes = await fetch(fallbackPlain, { cache: 'no-store' });
        if (!fbRes.ok) throw new Error("Impossible de récupérer les données");
        data = await fbRes.json();
      } else {
        data = await fallbackRes.json();
      }
    }

    console.log('[TheFrontStats] 🔍 Parsing des données...');
    setProgressBar(50);

    // Decode compact format if present (before existing format detection)
    const compact = decodeCompactPayload(data);
    if (compact) {
      allRuns = compact.runs;
      _rawRuns = allRuns;
      totalRunsCount = compact.totalCount || allRuns.length;
      gameCommit = compact.latestCommit;
      lastSyncTime = compact.lastUpdate;
      console.log("Données décompactées:", { 
        totalCount: totalRunsCount, 
        runsLength: allRuns.length
      });
    } else if (data.runs && Array.isArray(data.runs)) {
      // Support de l'ancien format (objet {runs, totalCount})
      allRuns = data.runs;
      _rawRuns = allRuns;
      totalRunsCount = data.totalCount || allRuns.length;
      gameCommit = data.latestCommit;
      lastSyncTime = data.lastUpdate;
      console.log("Données reçues:", { 
        totalCount: data.totalCount, 
        runsLength: data.runs.length
      });
    } else if (Array.isArray(data)) {
      allRuns = data;
      _rawRuns = allRuns;
      totalRunsCount = allRuns.length;
    } else {
      throw new Error("Format de données invalide");
    }
    
    console.log(`[TheFrontStats] ⚙️ Traitement de ${allRuns.length} runs (${currentMode})...`);
    setProgressBar(65);
    processData();
    setProgressBar(80);
    console.log('[TheFrontStats] 🎨 Rendu...');
    renderAll();
    if (!activeMap && allMaps.length) {
      selectMap(allMaps[0].map);
    }

    if(refreshInterval) clearInterval(refreshInterval);
    refreshInterval=setInterval(autoRefresh, 180000);
    hideProgressBar();
    const elapsed=((performance.now()-t0)/1000).toFixed(1);
    console.log(`[TheFrontStats] ✅ Chargé en ${elapsed}s — ${allRuns.length} runs, ${allMaps.length} maps (${currentMode})`);
    console.log(`[TheFrontStats] 🔄 Auto-sync ACTIF — rafraîchissement toutes les 3min`);
    console.timeEnd('loadData');
  }catch(e){
    console.error("Erreur critique chargement:", e);
    showToast("Erreur de chargement des données. Vérifiez votre connexion.", "error", 6000);
    hideProgressBar();
    const modeLabel = currentMode === 'compact' ? 'compact' : 'normal';
    document.getElementById("map-list").innerHTML=`<div class="error">Erreur: ${e.message}<br><small>Aucune donnée ${modeLabel} disponible pour le moment.</small></div>`;
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
  allMaps.forEach(m => m.runs.sort((a,b) => a.duration_s - b.duration_s));
  
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
      // FIX: increment(-1) ne fonctionne pas avec setDoc+merge — Firestore écrit -1 au lieu de décrémenter
      // On utilise deleteField pour supprimer l'utilisateur, puis recalculer le count
      const { deleteField } = await import('./auth.js');
      await setDoc(likeRef, {
        ['users.' + userId]: deleteField()
      }, { merge: true });
      // Re-lire le doc pour recalculer le count après suppression
      const updatedDoc = await getDoc(likeRef);
      if (updatedDoc.exists()) {
        const updatedData = updatedDoc.data();
        const remainingUsers = updatedData.users || {};
        const newCount = Object.keys(remainingUsers).length;
        await setDoc(likeRef, { count: newCount }, { merge: true });
        globalLikes[runId] = { ...updatedData, count: newCount, users: remainingUsers };
      }
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

  // Check if this player has a registered account
  if(connectedUsernames.has(name)){
    window.location.href="profile.html?player="+encodeURIComponent(name);
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
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
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
    const tabs=['maps','global','stats'];
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
    const tabs = ['maps', 'global', 'stats'];
    const idx = tabs.indexOf(tabParam);
    if (idx >= 0 && btns[idx]) switchTab(tabParam, btns[idx]);
  }
});

async function mockLogin(name, publicId) {
  currentUser = {
    name: name,
    publicId: publicId,
    avatar: null,
    uid: "mock-uid-123"
  };
  await fetchPlayerClientIds(publicId, []);
  updateAuthUI(currentUser);
  processData();
  renderAll();
}

// Export functions to window for HTML event handlers (module script = not global by default)
window.requestNotifs = requestNotifs;
window.toggleAuthModal = toggleAuthModal;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.toggleUserDropdown = toggleUserDropdown;
window.goToProfilePage = goToProfilePage;
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
window.selectMap = selectMap;
window.seeMore = seeMore;
window.shareMap = shareMap;
window.toggleGG = toggleGG;
window.showPlayer = showPlayer;
window.addCompare = addCompare;
window.searchCompare = searchCompare;
window.searchPlayer = searchPlayer;
window.filterMaps = filterMaps;
window.switchTab = switchTab;
window.switchMode = switchMode;
window.closeModal = closeModal;
window.renderAll = renderAll;
window.toggleUserDropdown = toggleUserDropdown;
window.closeUserDropdown = closeUserDropdown;
window.goToProfilePage = goToProfilePage;
window.mockLogin = mockLogin;
