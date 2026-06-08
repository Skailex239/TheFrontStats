import {
  auth, db, doc, getDoc, getDocs, setDoc, onSnapshot, onAuthStateChanged,
  collection, query, where,
} from "./auth.js";
import { fetchOpenFront, parseSessionsPayload, normalizeSession } from "./openfront-client.js";

const t = window.t || ((key) => key);

let currentUser = null;
let firestoreProfile = null;
let playerClientIds = new Set();
let playerAliases = new Set();
let playerGameIds = new Set();
let playerSessionMap = new Map(); // gameId → session (pour vérifier hasWon)
let allRuns = [];
let globalLeaderboard = [];
let playerStats = {};

let apiPlayerInfo = null;
let apiSessions = [];

let aliasMap = {};

/* ── Helpers ── */

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function show(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? "block" : "none";
}

function showProfileView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => show(id, id === view));
}

/* ── Data loading ── */

async function loadRunsData() {
  let data;
  try {
    const [gzRes] = await Promise.allSettled([
      fetch(`runs.json.gz?_=${Date.now()}`),
    ]);
    if (gzRes.status === "fulfilled" && gzRes.value.ok) {
      try {
        const buf = await gzRes.value.arrayBuffer();
        const ds = new DecompressionStream("gzip");
        const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
        data = JSON.parse(new TextDecoder().decode(out));
      } catch(e) {
        console.warn("[profile] GZIP decompression failed, trying fallback:", e);
      }
    }
  } catch(e) { console.warn("[profile] loadRunsData fetch error:", e); }
  if (!data) {
    try {
      const r = await fetch(`runs.json?_=${Date.now()}`);
      if (!r.ok) throw new Error("runs.json HTTP " + r.status);
      data = await r.json();
    } catch(e) {
      console.error("[profile] Fallback runs.json also failed:", e);
      data = { runs: [] };
    }
  }
  allRuns = Array.isArray(data) ? data : (data.runs || []);
}

/* ── Leaderboard & matching ── */

function buildLeaderboard() {
  playerStats = {};

  // Invalidate cache so aliasMap enrichment is picked up
  _nameToPlayerIdCache = null;
  const nameToPlayerId = buildNameToPlayerId();

  // ── FIX: Inject logged-in user's aliases into aliasMap for DETERMINISTIC leaderboard ──
  // This ensures the leaderboard is computed the same way regardless of who views it.
  if (currentUser) {
    const virtualPid = '__connected_user__' + currentUser.uid;
    const allMyAliases = new Set([currentUser.name, ...playerAliases]);

    // Pre-scan runs to discover additional aliases that belong to this user
    allRuns.forEach(r => {
      if (playerGameIds.has(r.id)) {
        const session = playerSessionMap.get(r.id);
        if (session && session.hasWon === false) return;
        if (r.player) allMyAliases.add(r.player);
      }
    });

    aliasMap[virtualPid] = { name: currentUser.name, aliases: [...allMyAliases] };
    allMyAliases.forEach(alias => { nameToPlayerId[alias] = virtualPid; });

    // Also map client IDs that may appear as run.playerId
    playerClientIds.forEach(cid => {
      if (cid && !aliasMap[cid]) {
        aliasMap[cid] = { name: currentUser.name, aliases: [] };
      } else if (cid && aliasMap[cid] && aliasMap[cid].name !== currentUser.name) {
        aliasMap[cid] = { name: currentUser.name, aliases: aliasMap[cid].aliases || [] };
      }
      if (cid) nameToPlayerId[cid] = cid;
    });
  }

  allRuns.forEach((run) => {
    const name = getCanonicalPlayerName(run, nameToPlayerId);
    if (!name) return;
    if (!playerStats[name]) {
      playerStats[name] = { wins: 0, maps: new Set(), runs: [], points: 0 };
    }
    const p = playerStats[name];
    p.wins++;
    p.maps.add(run.map);
    p.runs.push({ ...run, player: name });
  });
  Object.values(playerStats).forEach((p) => {
    p.points = p.wins * 10 + p.maps.size * 5;
  });
  globalLeaderboard = Object.entries(playerStats)
    .map(([player, s]) => ({ player, points: s.points, wins: s.wins }))
    .sort((a, b) => b.points - a.points);
}

function isMyFFAWin(run) {
  if (!currentUser || !playerGameIds.has(run.id)) return false;
  const session = playerSessionMap.get(run.id);
  if (session && session.hasWon === false) return false;
  return true;
}

function getCanonicalPlayerName(run, nameToPlayerIdOverride) {
  // aliasMap is enriched with logged-in user's aliases
  // isMyFFAWin() is NOT used for name resolution to ensure deterministic leaderboard.
  let pid = run.playerId;
  if (!pid) {
    const n2p = nameToPlayerIdOverride || buildNameToPlayerId();
    pid = n2p[run.player];
  }
  if (pid && aliasMap[pid]?.name) return aliasMap[pid].name;
  return run.player;
}

let _nameToPlayerIdCache = null;
function buildNameToPlayerId() {
  if (_nameToPlayerIdCache) return _nameToPlayerIdCache;
  _nameToPlayerIdCache = {};
  for (const [pid, data] of Object.entries(aliasMap)) {
    (data.aliases || []).forEach(alias => { _nameToPlayerIdCache[alias] = pid; });
    if (data.name) _nameToPlayerIdCache[data.name] = pid;
  }
  return _nameToPlayerIdCache;
}

function getMyRuns() {
  if (!currentUser || playerGameIds.size === 0) return [];
  return allRuns.filter((r) => isMyFFAWin(r));
}

/* ── API error banner ── */

function showApiError(msg) {
  const box = document.getElementById("profile-api-error");
  if (!box) return;
  if (msg) {
    box.hidden = false;
    box.textContent = msg;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
}

/* ── Render: Profile card ── */

function renderProfileCard() {
  const av = document.getElementById("profile-avatar-large");
  const title = document.getElementById("profile-title-name");
  const badge = document.getElementById("profile-public-badge");
  if (!currentUser) return;

  if (av) {
    if (currentUser.avatar) {
      av.innerHTML = `<img src="${esc(currentUser.avatar)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      const ini = (currentUser.name || "U").slice(0, 2).toUpperCase();
      av.textContent = ini;
      av.style.background = "linear-gradient(135deg, var(--accent), var(--accentL))";
    }
  }
  if (title) title.textContent = currentUser.name || "—";
  if (badge) badge.textContent = currentUser.publicId || "Pas de Public ID";
}

/* ── Render: Stats row ── */

function renderStatsRow(sessions) {
  // Total wins = toutes les sessions gagnées (tous modes confondus : FFA, équipe, etc.)
  const totalWins = sessions.filter((s) => s.hasWon).length;
  // Maps uniques jouées
  const maps = new Set(sessions.map((s) => s.map).filter(Boolean));

  // Rang sur le leaderboard TheFrontStats (FFA uniquement)
  // FIX: Search using ALL known aliases, not just currentUser.name.
  // The leaderboard may use a different canonical name than currentUser.name
  // if the aliasMap maps to a different display name.
  let rank = 0;
  if (currentUser) {
    // Collect all names that could represent this user in the leaderboard
    const searchNames = new Set([currentUser.name, ...playerAliases]);
    // Also check the aliasMap for the canonical name that might appear
    for (const [pid, data] of Object.entries(aliasMap)) {
      if (data.name && (
        data.name === currentUser.name ||
        (data.aliases || []).some(a => a === currentUser.name || playerAliases.has(a))
      )) {
        searchNames.add(data.name);
      }
    }
    for (let i = 0; i < globalLeaderboard.length; i++) {
      if (searchNames.has(globalLeaderboard[i].player)) {
        rank = i + 1;
        break;
      }
    }
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("profile-stat-wins", String(totalWins));
  set("profile-stat-sessions", String(sessions.length));
  set("profile-stat-maps", String(maps.size));
  set("profile-stat-global-rank", rank > 0 ? `#${rank}` : "—");
}

/* ── Render: Monthly wins chart ── */

function buildMonthlyWins(sessions) {
  const months = [];
  const now = new Date();

  // Last 6 months
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const label = d.toLocaleDateString(undefined, { month: "short" });
    months.push({ key, label, value: 0 });
  }

  // Count WINS per month from API sessions (tous modes confondus)
  sessions.forEach((s) => {
    if (!s.hasWon) return; // Seulement les victoires
    const raw = s.start || s.end;
    if (!raw) return;
    const d = new Date(raw);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const slot = months.find((m) => m.key === key);
    if (slot) slot.value++;
  });

  return months;
}

function renderMonthlyChart(sessions) {
  const el = document.getElementById("chart-monthly-wins");
  if (!el) return;

  const buckets = buildMonthlyWins(sessions);
  const max = Math.max(1, ...buckets.map((b) => b.value));

  if (!buckets.some(b => b.value > 0)) {
    el.innerHTML = `<div class="pf-empty">Aucune victoire pour le moment</div>`;
    return;
  }

  el.innerHTML = buckets.map((b) => `
    <div class="pf-chart-row">
      <span class="pf-chart-label">${esc(b.label)}</span>
      <div class="pf-chart-track">
        <div class="pf-chart-fill" style="width:${Math.round((b.value / max) * 100)}%"></div>
      </div>
      <span class="pf-chart-val">${b.value}</span>
    </div>
  `).join("");
}

/* ── Render: Last 5 games (from API sessions — ALL game types) ── */

function renderRecentGames(sessions) {
  const box = document.getElementById("profile-recent-games");
  if (!box) return;

  // Trier par date décroissante, prendre les 5 plus récentes
  const recent = [...sessions]
    .sort((a, b) => {
      const ta = new Date(a.start || a.end || 0).getTime();
      const tb = new Date(b.start || b.end || 0).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  if (!recent.length) {
    box.innerHTML = `<div class="pf-empty">Aucune partie trouvée — vérifiez votre Public ID</div>`;
    return;
  }

  box.innerHTML = recent.map((s) => {
    const mapName = esc(s.map || "—");
    const mode = esc(s.mode || s.type || "—");
    const url = s.gameId ? `https://openfront.io/game/${s.gameId}` : "#";
    const won = s.hasWon === true;
    const date = formatDate(s.start || s.end);

    // Calculer la durée si possible
    let duration = "";
    if (s.start && s.end) {
      const dur = Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000);
      if (dur > 0) duration = formatDuration(dur);
    }

    return `
      <a class="pf-game" href="${esc(url)}" target="_blank" rel="noopener">
        <div class="pf-game-icon ${won ? "won" : "lost"}">${won ? "W" : "L"}</div>
        <div class="pf-game-body">
          <div class="pf-game-map">${mapName}</div>
          <div class="pf-game-meta">${mode}${duration ? " · " + duration : ""} · ${date}</div>
        </div>
        <div class="pf-game-link">▶</div>
      </a>
    `;
  }).join("");
}

function formatDuration(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ── OpenFront API fetch ── */

function applySessionsFromFirestore(data) {
  const sessions = Array.isArray(data?.openFrontSessions) ? data.openFrontSessions : [];
  playerClientIds = new Set(sessions.map((s) => s.clientId).filter(Boolean));
  playerAliases = new Set(sessions.map((s) => s.username).filter(Boolean));
  playerGameIds = new Set(sessions.map((s) => s.gameId || s.game || s.id).filter(Boolean));
  playerSessionMap = new Map();
  sessions.forEach((s) => {
    const gid = s.gameId || s.game || s.id;
    if (gid) playerSessionMap.set(gid, s);
  });
  // Normaliser les sessions Firestore pour qu'elles aient la même structure que les sessions API
  return sessions.map((s) => normalizeSession(s)).filter(Boolean);
}

async function fetchOpenFrontPlayerData(publicId) {
  if (!publicId) return { info: null, sessions: [] };

  let info = null;
  let sessions = [];

  try {
    try {
      info = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    } catch (e) {
      console.warn("[profile] Erreur fetch player info:", e.message);
    }

    try {
      const raw = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}/sessions`);
      sessions = parseSessionsPayload(raw, info);
    } catch (e) {
      console.warn("[profile] Erreur fetch sessions:", e.message);
    }
  } catch (e) {
    console.error("[profile] Erreur globale fetchOpenFrontPlayerData:", e);
  }

  return { info, sessions };
}

/* ── Refresh profile ── */

async function refreshProfile() {
  if (!currentUser?.publicId) return;

  showApiError(null);

  const apiData = await fetchOpenFrontPlayerData(currentUser.publicId);
  apiPlayerInfo = apiData.info;
  apiSessions = apiData.sessions;

  if (apiSessions.length > 0) {
    playerClientIds = new Set(apiSessions.map((s) => s.clientId).filter(Boolean));
    playerAliases = new Set(apiSessions.map((s) => s.username).filter(Boolean));
    playerGameIds = new Set(apiSessions.map((s) => s.gameId || s.game || s.id).filter(Boolean));
    playerSessionMap = new Map();
    apiSessions.forEach((s) => {
      const gid = s.gameId || s.game || s.id;
      if (gid) playerSessionMap.set(gid, s);
    });
  } else {
    const data = firestoreProfile || {};
    applySessionsFromFirestore(data);
  }

  if (apiSessions.length > 0 && currentUser.uid) {
    try {
      _skipNextSnapshot = true; // Ignorer le prochain snapshot causé par notre propre write
      const ref = doc(db, "users", currentUser.uid);
      const update = {
        openFrontSessions: apiSessions.map(s => ({
          clientId: s.clientId || null,
          username: s.username || null,
          gameId: s.gameId || null,
          map: s.map || null,
          mode: s.mode || null,
          type: s.type || null,
          hasWon: s.hasWon || false,
          start: s.start || null,
          end: s.end || null,
        })),
        openFrontPlayerInfo: apiPlayerInfo,
        openFrontSyncedAt: new Date().toISOString(),
        openFrontSyncPending: false,
      };
      await setDoc(ref, update, { merge: true });
    } catch (e) {
      console.warn("[profile] Erreur mise à jour Firestore:", e);
      _skipNextSnapshot = false;
    }
  }

  const sessions = apiSessions.length > 0
    ? apiSessions
    : applySessionsFromFirestore(firestoreProfile || {});

  if (!sessions.length) {
    const data = firestoreProfile || {};
    if (data.openFrontSyncPending || !data.openFrontSyncedAt) {
      showApiError("Synchronisation en cours...");
    }
  }

  // ── Publier les aliases dans public-aliases pour que TOUS les viewers voient la fusion ──
  await publishPublicAliases(apiSessions);

  // Render everything — on utilise les sessions API (tous modes, avec hasWon)
  renderStatsRow(sessions);
  renderMonthlyChart(sessions);
  renderRecentGames(sessions);
}

/**
 * Publie les aliases du joueur dans la collection publique Firestore "public-aliases".
 * Cela permet à TOUS les viewers (même non connectés) de voir les pseudos fusionnés.
 *
 * Inclut maintenant les verifiedGameIds : les gameId des parties effectivement gagnées
 * par ce joueur (via l'API OpenFront). Cela permet à sync.js de construire une map
 * gameId → canonicalName qui résout les conflits quand deux joueurs différents
 * ont utilisé le même pseudo in-game.
 */
async function publishPublicAliases(sessions) {
  if (!currentUser?.publicId || !currentUser.uid) return;

  const aliases = [...new Set([
    currentUser.name,
    ...sessions.map(s => s.username).filter(Boolean),
  ])];

  const clientIds = [...new Set(sessions.map(s => s.clientId).filter(Boolean))];

  // Parties gagnées vérifiées par l'API — clé pour résoudre les conflits de pseudos
  const verifiedGameIds = [...new Set(
    sessions
      .filter(s => s.hasWon === true)
      .map(s => s.gameId || s.game || s.id)
      .filter(Boolean)
  )];

  if (aliases.length <= 1 && clientIds.length === 0) return; // Rien à fusionner

  try {
    await setDoc(doc(db, "public-aliases", currentUser.publicId), {
      username: currentUser.name,
      publicId: currentUser.publicId,
      aliases: aliases,
      clientIds: clientIds,
      verifiedGameIds: verifiedGameIds,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    console.log(`[profile] ${aliases.length} aliases + ${verifiedGameIds.length} gameIds vérifiés publiés`);
  } catch (e) {
    console.warn("[profile] Erreur publication public-aliases:", e);
  }
}

/* ── Reward code system (multi-cosmetic) ── */

let ownedTypes = [];       // Tous les cosmétiques possédés: ["vip", "flame", "rainbow"]
let activeType = null;     // Le cosmétique actuellement sélectionné (ou null)
let rewardActivated = true; // Toggle global on/off
let redeemInProgress = false; // Debounce flag to prevent double-clicks

const REWARD_LABELS = {
  prism:     { name: "PRISM",     desc: "Prisme multicouleurs néon pulsant", css: "rgb-prism" },
};

/**
 * Charge les récompenses du joueur depuis la collection public-rewards
 */
async function loadUserReward() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, "public-rewards", currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      // Migration: ancien format {type, activated} → nouveau format {ownedTypes, activeType, activated}
      if (data.ownedTypes && Array.isArray(data.ownedTypes)) {
        ownedTypes = data.ownedTypes;
        activeType = data.activeType || null;
        rewardActivated = data.activated !== false;
      } else if (data.type) {
        // Ancien format → migration automatique
        ownedTypes = [data.type];
        activeType = data.type;
        rewardActivated = data.activated !== false;
        // Migrer vers le nouveau format dans Firestore
        await setDoc(doc(db, "public-rewards", currentUser.uid), {
          ownedTypes: ownedTypes,
          activeType: activeType,
          activated: rewardActivated,
        }, { merge: true });
      } else {
        ownedTypes = [];
        activeType = null;
        rewardActivated = true;
      }
    } else {
      ownedTypes = [];
      activeType = null;
      rewardActivated = true;
    }
  } catch (e) {
    console.warn("[profile] Erreur chargement récompense:", e);
    ownedTypes = [];
    activeType = null;
    rewardActivated = true;
  }
  renderRewardSection();
  applyProfileVipStyle();
}

/**
 * Affiche l'état des récompenses dans le profil
 */
function renderRewardSection() {
  const activeSection = document.getElementById("pf-reward-active");
  const form = document.getElementById("pf-reward-form");
  const cosmeticsGrid = document.getElementById("pf-cosmetics-grid");
  const toggleSwitch = document.getElementById("pf-reward-toggle-switch");
  const toggleLabel = document.getElementById("pf-toggle-label");

  if (ownedTypes.length > 0) {
    if (activeSection) activeSection.style.display = "block";
    if (form) form.style.display = "block"; // Toujours afficher le form pour ajouter d'autres codes

    // Afficher la grille de cosmétiques possédés
    if (cosmeticsGrid) {
      // Carte "Aucun" en premier
      const noneCard = `
        <div class="pf-cosmetic-card none ${!activeType ? 'selected' : ''}" onclick="selectCosmetic(null)">
          <span class="pf-none-icon">✕</span>
          <span class="pf-cosmetic-name">Aucun</span>
          <span class="pf-cosmetic-desc">Pas de skin actif</span>
          ${!activeType ? '<span class="pf-cosmetic-check">✓</span>' : ''}
        </div>
      `;
      const cards = ownedTypes.map(type => {
        const info = REWARD_LABELS[type] || { name: type.toUpperCase(), desc: "Cosmétique spécial", css: `player-${type}` };
        const isSelected = type === activeType;
        const cssClass = info.css || `player-${type}`;
        return `
          <div class="pf-cosmetic-card ${isSelected ? 'selected' : ''} ${type}" onclick="selectCosmetic('${type}')">
            <span class="pf-cosmetic-preview ${cssClass}">ABC</span>
            <span class="pf-cosmetic-name">${info.name}</span>
            <span class="pf-cosmetic-desc">${info.desc}</span>
            ${isSelected ? '<span class="pf-cosmetic-check">✓</span>' : ''}
          </div>
        `;
      }).join("");
      cosmeticsGrid.innerHTML = noneCard + cards;
    }

    // Mettre à jour le toggle global
    if (toggleSwitch) {
      toggleSwitch.classList.toggle("on", rewardActivated);
      // Retirer dynamiquement toutes les classes de skin
      Object.keys(REWARD_LABELS).forEach(k => toggleSwitch.classList.remove(`is-${k}`));
      if (activeType) toggleSwitch.classList.add(`is-${activeType}`);
    }
    if (toggleLabel) {
      toggleLabel.textContent = rewardActivated ? "Activé" : "Désactivé";
      toggleLabel.classList.toggle("off", !rewardActivated);
    }
  } else {
    if (activeSection) activeSection.style.display = "none";
    if (form) form.style.display = "block";
  }
}

/**
 * Sélectionne un cosmétique parmi ceux possédés
 */
window.selectCosmetic = async (type) => {
  if (!currentUser) return;
  // type === null means "Aucun" (deselect), otherwise must be owned
  if (type !== null && !ownedTypes.includes(type)) return;

  // Si on clique sur celui déjà actif, on le désélectionne (activeType = null)
  const newActiveType = (type === activeType) ? null : type;

  try {
    await setDoc(doc(db, "public-rewards", currentUser.uid), {
      activeType: newActiveType,
      activated: newActiveType ? true : rewardActivated,
    }, { merge: true });

    activeType = newActiveType;
    if (newActiveType) rewardActivated = true;
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {
    console.error("[profile] Erreur sélection cosmétique:", e);
  }
};

/**
 * Active ou désactive le cosmétique (toggle global)
 */
window.toggleReward = async () => {
  if (!currentUser || ownedTypes.length === 0) return;

  const newState = !rewardActivated;

  try {
    await setDoc(doc(db, "public-rewards", currentUser.uid), {
      activated: newState,
    }, { merge: true });

    rewardActivated = newState;
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {
    console.error("[profile] Erreur toggle récompense:", e);
  }
};

/**
 * Applique ou retire le style cosmétique sur le nom du profil
 */
function applyProfileVipStyle() {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;

  // Retirer tous les styles cosmétiques (anciens + nouveaux)
  nameEl.classList.remove(
    "player-vip", "player-flame", "player-rainbow",
    "rgb-cyberpunk", "rgb-sunset", "rgb-aurore", "rgb-pastel",
    "rgb-gold", "rgb-volcano", "rgb-ocean", "rgb-miami", "rgb-toxic", "rgb-chroma",
    "rgb-prism"
  );

  // Appliquer le style du cosmétique actif si activé
  if (activeType && rewardActivated) {
    const info = REWARD_LABELS[activeType];
    if (info && info.css) {
      nameEl.classList.add(info.css);
    } else {
      nameEl.classList.add(`player-${activeType}`);
    }
  }
}

window.redeemCode = async () => {
  const input = document.getElementById("reward-code-input");
  const msgEl = document.getElementById("reward-code-msg");
  if (!input || !currentUser) return;

  // Debounce: prevent rapid double-clicks
  if (redeemInProgress) {
    if (msgEl) { msgEl.textContent = "Vérification en cours..."; msgEl.className = "pf-reward-msg"; }
    return;
  }

  const code = input.value.trim().toUpperCase();
  if (!code) {
    if (msgEl) { msgEl.textContent = "Entrez un code."; msgEl.className = "pf-reward-msg error"; }
    return;
  }

  redeemInProgress = true;
  if (msgEl) { msgEl.textContent = "Vérification..."; msgEl.className = "pf-reward-msg"; }

  try {
    // Step 1: Query the code WITHOUT the 'used' filter to check if it exists at all
    const q = query(collection(db, "reward-codes"), where("code", "==", code));
    const snap = await getDocs(q);

    // Code doesn't exist at all
    if (snap.empty) {
      if (msgEl) { msgEl.textContent = "Code invalide."; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    const codeDoc = snap.docs[0];
    const codeData = codeDoc.data();
    const rewardType = codeData.type || "vip";
    const redeemedBy = Array.isArray(codeData.redeemedBy) ? codeData.redeemedBy : [];

    // Step 2: Check if current user already redeemed this code
    if (redeemedBy.includes(currentUser.uid)) {
      if (msgEl) { msgEl.textContent = "Vous avez déjà utilisé ce code."; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    // Step 3: Check if someone else already used this code (globally single-use)
    if (codeData.used === true && redeemedBy.length > 0 && !redeemedBy.includes(currentUser.uid)) {
      if (msgEl) { msgEl.textContent = "Ce code a déjà été utilisé."; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    // Step 4: Check if user already owns this cosmetic type
    if (ownedTypes.includes(rewardType)) {
      if (msgEl) { msgEl.textContent = "Vous possédez déjà ce cosmétique !"; msgEl.className = "pf-reward-msg error"; }
      return;
    }

    // Step 5: Redeem — update code doc, user rewards, and user profile
    const newRedeemedBy = [...redeemedBy, currentUser.uid];
    const newOwnedTypes = [...ownedTypes, rewardType];
    const newActiveType = rewardType; // Nouveau code → automatiquement actif
    const now = new Date().toISOString();

    // Consolidate Firestore writes — do them in parallel
    await Promise.all([
      // Mark the code as used (per-user tracking via redeemedBy array)
      setDoc(doc(db, "reward-codes", codeDoc.id), {
        used: true,
        redeemedBy: newRedeemedBy,
        lastUsedBy: currentUser.uid,
        lastUsedAt: now,
      }, { merge: true }),

      // Add cosmetic to user's owned list
      setDoc(doc(db, "public-rewards", currentUser.uid), {
        username: currentUser.name,
        ownedTypes: newOwnedTypes,
        activeType: newActiveType,
        activated: true,
        activatedAt: now,
      }, { merge: true }),

      // Update user profile
      setDoc(doc(db, "users", currentUser.uid), {
        reward: newActiveType,
      }, { merge: true }),
    ]);

    ownedTypes = newOwnedTypes;
    activeType = newActiveType;
    rewardActivated = true;
    renderRewardSection();
    applyProfileVipStyle();

    if (msgEl) { msgEl.textContent = `Cosmétique ${REWARD_LABELS[rewardType]?.name || rewardType} débloqué ! 🎉`; msgEl.className = "pf-reward-msg success"; }
    input.value = "";
  } catch (e) {
    console.error("[profile] Erreur redemption code:", e);
    if (msgEl) { msgEl.textContent = "Erreur lors de l'activation. Réessayez."; msgEl.className = "pf-reward-msg error"; }
  } finally {
    redeemInProgress = false;
  }
};

/* ── Firestore save ── */

async function saveProfileToFirestore(username, publicIdNew) {
  const uid = currentUser.uid;
  const ref = doc(db, "users", uid);
  const existing = firestoreProfile || {};

  if (existing.publicId && publicIdNew && publicIdNew !== existing.publicId) {
    showToast("Le Public ID ne peut pas être modifié.", "error");
    return false;
  }

  const payload = {
    username,
    email: currentUser.email || existing.email || "",
    updatedAt: new Date().toISOString(),
  };

  if (!existing.publicId && publicIdNew) {
    payload.publicId = publicIdNew;
    payload.createdAt = new Date().toISOString();
    payload.openFrontSyncPending = true;
  } else if (existing.publicId) {
    payload.publicId = existing.publicId;
  }

  await setDoc(ref, payload, { merge: true });
  firestoreProfile = { ...existing, ...payload };
  currentUser.name = username;
  currentUser.publicId = payload.publicId;
  return true;
}

/* ── Window-exposed handlers ── */

window.saveInitialProfile = async () => {
  const username = document.getElementById("setup-username")?.value.trim();
  const publicId = document.getElementById("setup-public-id")?.value.trim();
  if (!username || !publicId) {
    showToast("Remplissez tous les champs.", "warning");
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
  if (!(await saveProfileToFirestore(username, publicId))) return;
  showProfileView("profile-main");
  renderProfileCard();
  await refreshProfile();
};

window.saveProfileEdits = async () => {
  const username = document.getElementById("edit-username")?.value.trim();
  if (!username) {
    showToast("Entrez un nom d'utilisateur.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -", "warning");
    return;
  }
  if (!(await saveProfileToFirestore(username, currentUser.publicId))) return;
  toggleEditPanel();
  renderProfileCard();
  updateAuthUI(currentUser);
  await refreshProfile();
};

window.toggleEditPanel = () => {
  const panel = document.getElementById("profile-edit-panel");
  if (!panel) return;
  const open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  if (!open && currentUser) {
    document.getElementById("edit-username").value = currentUser.name || "";
    document.getElementById("edit-public-id").value = currentUser.publicId || "";
  }
};

window.toggleAuthModal = () => {
  document.getElementById("auth-modal")?.classList.toggle("active");
};

window.handleLogin = async (provider) => {
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    toggleAuthModal();
  } catch (e) {
    console.error(e);
  }
};

window.handleLogout = (e) => {
  if (e) e.stopPropagation();
  if (confirm("Se déconnecter ?")) {
    window.logout();
    window.location.href = "index.html";
  }
};

window.toggleUserDropdown = (e) => {
  if (e) e.stopPropagation();
  document.getElementById("user-container")?.classList.toggle("open");
};

function updateAuthUI(user) {
  const login = document.getElementById("login-btn-main");
  const container = document.getElementById("user-container");
  if (user) {
    if (login) login.style.display = "none";
    if (container) container.style.display = "block";
    const nameEl = document.getElementById("user-display-name");
    if (nameEl) nameEl.textContent = user.name || "User";
  } else {
    if (login) login.style.display = "flex";
    if (container) container.style.display = "none";
  }
}

document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ── Public profile viewer (when ?player=Name is in URL) ── */

async function showPublicProfile(targetName) {
  const loadingEl = document.getElementById("profile-loading");
  const viewerEl = document.getElementById("profile-public-viewer");
  if (!viewerEl || !loadingEl) return;

  loadingEl.style.display = "block";
  viewerEl.style.display = "none";

  try {
    await loadRunsData();

    // Build a simple playerStats for all players from runs data
    const stats = {};
    allRuns.forEach(function(r) {
      if (!r.player) return;
      if (!stats[r.player]) stats[r.player] = { wins: 0, maps: new Set(), runs: [], points: 0, totalTime: 0 };
      const p = stats[r.player];
      p.wins++;
      p.maps.add(r.map);
      p.runs.push(r);
      p.totalTime += (r.duration_s || 0);
    });
    Object.values(stats).forEach(function(p) {
      p.points = p.wins * 10 + p.maps.size * 5;
    });

    // Find the player (case-insensitive fallback)
    let target = stats[targetName];
    if (!target) {
      const lower = targetName.toLowerCase();
      for (const [name, s] of Object.entries(stats)) {
        if (name.toLowerCase() === lower) { target = s; break; }
      }
    }

    if (!target) {
      loadingEl.style.display = "none";
      viewerEl.style.display = "block";
      document.getElementById("public-title-name").textContent = targetName;
      document.getElementById("public-profile-badge").textContent = "Aucune donn\u00e9e trouv\u00e9e";
      document.getElementById("public-stat-wins").textContent = "0";
      document.getElementById("public-stat-maps").textContent = "0";
      document.getElementById("public-stat-global-rank").textContent = "\u2014";
      document.getElementById("public-recent-games").innerHTML = "<p style='color:var(--text3);text-align:center;padding:16px'>Aucun run trouv\u00e9 pour ce joueur.</p>";
      return;
    }

    // Compute global rank
    const sorted = Object.entries(stats).sort(function(a, b) { return b[1].points - a[1].points; });
    let rank = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i][0] === targetName || sorted[i][0].toLowerCase() === targetName.toLowerCase()) { rank = i + 1; break; }
    }

    // Render
    loadingEl.style.display = "none";
    viewerEl.style.display = "block";

    const nameEl = document.getElementById("public-title-name");
    if (nameEl) nameEl.textContent = targetName;

    const badge = document.getElementById("public-profile-badge");
    if (badge) badge.textContent = "Profil public";

    const av = document.getElementById("public-avatar-large");
    if (av) {
      av.textContent = targetName.slice(0, 2).toUpperCase();
      av.style.background = "linear-gradient(135deg, var(--accent), var(--accentL))";
    }

    document.getElementById("public-stat-wins").textContent = String(target.wins);
    document.getElementById("public-stat-maps").textContent = String(target.maps.size);
    document.getElementById("public-stat-global-rank").textContent = rank > 0 ? "#" + rank : "\u2014";

    // Recent games (last 10)
    const recent = target.runs.slice(-10).reverse();
    document.getElementById("public-recent-games").innerHTML = recent.map(function(r) {
      return "<div class='feed-item' style='display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border)'>" +
        "<div><span style='font-weight:600'>" + esc(r.map || "?") + "</span></div>" +
        "<div><span style='color:var(--accent)'>" + formatTime(r.duration_s || 0) + "</span></div>" +
        "</div>";
    }).join("");

    // Hide own profile sections
    show("profile-gate", false);
    show("profile-setup", false);
    show("profile-main", false);

  } catch (e) {
    console.error("[profile] Public viewer error:", e);
    loadingEl.style.display = "none";
    viewerEl.style.display = "block";
    document.getElementById("public-recent-games").innerHTML = "<p style='color:var(--text3);text-align:center'>Erreur de chargement.</p>";
  }
}

// Check for ?player= parameter at load time
(function() {
  const params = new URLSearchParams(window.location.search);
  const targetPlayer = params.get("player");
  if (targetPlayer) {
    showPublicProfile(targetPlayer);
  }
})();

/* ── Auth state ── */

let profileUnsub = null;
let _skipNextSnapshot = false; // Éviter la boucle onSnapshot → refreshProfile → setDoc → onSnapshot

onAuthStateChanged(auth, async (user) => {
  if (profileUnsub) {
    profileUnsub();
    profileUnsub = null;
  }
  showProfileView("profile-loading");

  if (!user) {
    currentUser = null;
    firestoreProfile = null;
    updateAuthUI(null);
    showProfileView("profile-gate");
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || !snap.data().publicId) {
      currentUser = { uid: user.uid, avatar: user.photoURL, email: user.email };
      firestoreProfile = snap.exists() ? snap.data() : {};
      const setupUser = document.getElementById("setup-username");
      const setupId = document.getElementById("setup-public-id");
      if (setupUser && firestoreProfile.username) setupUser.value = firestoreProfile.username;
      if (setupId && firestoreProfile.publicId) setupId.value = firestoreProfile.publicId;
      updateAuthUI(currentUser);
      showProfileView("profile-setup");
      return;
    }

    const data = snap.data();
    firestoreProfile = data;
    currentUser = {
      uid: user.uid,
      name: data.username || user.displayName || "Joueur",
      publicId: data.publicId,
      avatar: user.photoURL,
      email: user.email,
    };

    applySessionsFromFirestore(data);

    updateAuthUI(currentUser);
    showProfileView("profile-main");
    renderProfileCard();

    await loadRunsData();
    buildLeaderboard();
    await refreshProfile();
    await loadUserReward();

    profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (!snap.exists()) return;
      // Éviter la boucle : si on vient d'écrire, on ignore ce snapshot
      if (_skipNextSnapshot) {
        _skipNextSnapshot = false;
        firestoreProfile = snap.data();
        return;
      }
      firestoreProfile = snap.data();
      refreshProfile();
    }, (error) => {
      console.warn("[profile] Firestore user listener error (non-critique):", error.message);
    });
  } catch (e) {
    console.error("[profile]", e);
    showProfileView("profile-main");
  }
});
