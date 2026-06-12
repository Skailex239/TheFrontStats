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
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main", "profile-public-viewer"];
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
  if (currentUser) {
    const virtualPid = '__connected_user__' + currentUser.uid;
    const allMyAliases = new Set([currentUser.name, ...playerAliases]);

    allRuns.forEach(r => {
      if (playerGameIds.has(r.id)) {
        const session = playerSessionMap.get(r.id);
        if (session && session.hasWon === false) return;
        if (r.player) allMyAliases.add(r.player);
      }
    });

    aliasMap[virtualPid] = { name: currentUser.name, aliases: [...allMyAliases] };
    allMyAliases.forEach(alias => { nameToPlayerId[alias] = virtualPid; });

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

function renderStatsRow(sessions, prefix = "profile") {
  // Total wins = toutes les sessions gagnées (tous modes confondus : FFA, équipe, etc.)
  const totalWins = sessions.filter((s) => s.hasWon).length;
  // Maps uniques jouées
  const maps = new Set(sessions.map((s) => s.map).filter(Boolean));

  // Rang sur le leaderboard TheFrontStats (FFA uniquement)
  let rank = 0;
  
  if (prefix === "profile" && currentUser) {
    const searchNames = new Set([currentUser.name, ...playerAliases]);
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
  } else {
    const rankEl = document.getElementById(`${prefix}-stat-global-rank`);
    if (rankEl && rankEl.textContent !== "—") {
      rank = parseInt(rankEl.textContent.replace("#", "")) || 0;
    }
  }

  let totalPlayTimeSecs = 0;
  let totalWinTimeSecs = 0;
  const mapCounts = {};

  sessions.forEach(s => {
    let dur = 0;
    if (s.start && s.end) {
      dur = Math.round((new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000);
    } else if (s.duration) {
      dur = s.duration > 100000 ? Math.round(s.duration / 1000) : s.duration;
    }
    if (dur > 0) totalPlayTimeSecs += dur;
    
    if (s.hasWon) {
      if (dur > 0) totalWinTimeSecs += dur;
      if (s.map) {
        mapCounts[s.map] = (mapCounts[s.map] || 0) + 1;
      }
    }
  });

  let favMap = "—";
  let maxWins = 0;
  for (let m in mapCounts) {
    if (mapCounts[m] > maxWins) {
      maxWins = mapCounts[m];
      favMap = m;
    }
  }

  let playTimeHours = Math.round(totalPlayTimeSecs / 3600);
  let avgWinTimeSecs = totalWins > 0 ? Math.round(totalWinTimeSecs / totalWins) : 0;
  
  const formatSecs = (secs) => {
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, "0");
    return `${m}m${s}s`;
  };

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set(`${prefix}-stat-wins`, String(totalWins));
  set(`${prefix}-stat-maps`, String(maps.size));
  if (rank > 0) set(`${prefix}-stat-global-rank`, `#${rank}`);
  
  set(`${prefix}-stat-playtime`, playTimeHours + "h");
  set(`${prefix}-stat-favmap`, favMap);
  set(`${prefix}-stat-avgtime`, avgWinTimeSecs > 0 ? formatSecs(avgWinTimeSecs) : "—");
}

/* ── Render: Monthly wins chart ── */

function buildMonthlyWins(sessions) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const label = d.toLocaleDateString(undefined, { month: "short" });
    months.push({ key, label, value: 0 });
  }
  sessions.forEach((s) => {
    if (!s.hasWon) return;
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

/* ── Render: Last 5 games ── */

function renderRecentGames(sessions, prefix = "profile") {
  const boxId = prefix === "profile" ? "profile-recent-games" : `${prefix}-recent-games`;
  const box = document.getElementById(boxId);
  if (!box) return;

  const recent = [...sessions]
    .sort((a, b) => {
      const ta = new Date(a.start || a.end || 0).getTime();
      const tb = new Date(b.start || b.end || 0).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  if (!recent.length) {
    box.innerHTML = `<div class="pf-empty">Aucune partie trouvée — vérifiez le Public ID</div>`;
    return;
  }

  box.innerHTML = recent.map((s) => {
    const mapName = esc(s.map || "—");
    const mode = esc(s.mode || s.type || "—");
    const url = s.gameId ? `https://openfront.io/game/${s.gameId}` : "#";
    const won = s.hasWon === true;
    const date = formatDate(s.start || s.end);

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
  return sessions.map((s) => normalizeSession(s)).filter(Boolean);
}

async function fetchOpenFrontPlayerData(publicId) {
  if (!publicId) return { info: null, sessions: [] };
  let info = null;
  let sessions = [];
  try {
    try {
      info = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    } catch (e) { console.warn("[profile] Erreur fetch player info:", e.message); }
    try {
      const raw = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}/sessions`);
      sessions = parseSessionsPayload(raw, info);
    } catch (e) { console.warn("[profile] Erreur fetch sessions:", e.message); }
  } catch (e) { console.error("[profile] Erreur globale fetchOpenFrontPlayerData:", e); }
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
      _skipNextSnapshot = true;
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
  const sessions = apiSessions.length > 0 ? apiSessions : applySessionsFromFirestore(firestoreProfile || {});
  await publishPublicAliases(apiSessions);
  renderStatsRow(sessions, "profile");
  renderMonthlyChart(sessions);
  renderRecentGames(sessions, "profile");
  if (currentUser && currentUser.publicId) {
    loadRankedGames(currentUser.publicId, "profile-ranked-games");
  }
}

async function publishPublicAliases(sessions) {
  if (!currentUser?.publicId || !currentUser.uid) return;
  const aliases = [...new Set([currentUser.name, ...sessions.map(s => s.username).filter(Boolean)])];
  const clientIds = [...new Set(sessions.map(s => s.clientId).filter(Boolean))];
  const verifiedGameIds = [...new Set(sessions.filter(s => s.hasWon === true).map(s => s.gameId || s.game || s.id).filter(Boolean))];
  if (aliases.length <= 1 && clientIds.length === 0) return;
  try {
    await setDoc(doc(db, "public-aliases", currentUser.publicId), {
      username: currentUser.name,
      publicId: currentUser.publicId,
      aliases: aliases,
      clientIds: clientIds,
      verifiedGameIds: verifiedGameIds,
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (e) { console.warn("[profile] Erreur publication public-aliases:", e); }
}

/* ── Reward system ── */

let ownedTypes = [];
let activeType = null;
let rewardActivated = true;
let redeemInProgress = false;
const REWARD_LABELS = { prism: { name: "PRISM", desc: "Prisme multicouleurs néon pulsant", css: "rgb-prism" } };

async function loadUserReward() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, "public-rewards", currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      if (data.ownedTypes && Array.isArray(data.ownedTypes)) {
        ownedTypes = data.ownedTypes;
        activeType = data.activeType || null;
        rewardActivated = data.activated !== false;
      }
    }
  } catch (e) { console.warn("[profile] Erreur récompense:", e); }
  renderRewardSection();
  applyProfileVipStyle();
}

function renderRewardSection() {
  const activeSection = document.getElementById("pf-reward-active");
  const cosmeticsGrid = document.getElementById("pf-cosmetics-grid");
  const toggleSwitch = document.getElementById("pf-reward-toggle-switch");
  const toggleLabel = document.getElementById("pf-toggle-label");
  if (ownedTypes.length > 0) {
    if (activeSection) activeSection.style.display = "block";
    if (cosmeticsGrid) {
      const noneCard = `<div class="pf-cosmetic-card none ${!activeType ? 'selected' : ''}" onclick="selectCosmetic(null)"><span class="pf-none-icon">✕</span><span class="pf-cosmetic-name">Aucun</span><span class="pf-cosmetic-desc">Pas de skin actif</span>${!activeType ? '<span class="pf-cosmetic-check">✓</span>' : ''}</div>`;
      const cards = ownedTypes.map(type => {
        const info = REWARD_LABELS[type] || { name: type.toUpperCase(), desc: "Cosmétique spécial", css: `player-${type}` };
        const isSelected = type === activeType;
        return `<div class="pf-cosmetic-card ${isSelected ? 'selected' : ''} ${type}" onclick="selectCosmetic('${type}')"><span class="pf-cosmetic-preview ${info.css || ''}">ABC</span><span class="pf-cosmetic-name">${info.name}</span><span class="pf-cosmetic-desc">${info.desc}</span>${isSelected ? '<span class="pf-cosmetic-check">✓</span>' : ''}</div>`;
      }).join("");
      cosmeticsGrid.innerHTML = noneCard + cards;
    }
    if (toggleSwitch) toggleSwitch.classList.toggle("on", rewardActivated);
    if (toggleLabel) {
      toggleLabel.textContent = rewardActivated ? "Activé" : "Désactivé";
      toggleLabel.classList.toggle("off", !rewardActivated);
    }
  }
}

window.selectCosmetic = async (type) => {
  if (!currentUser) return;
  const newActiveType = (type === activeType) ? null : type;
  try {
    await setDoc(doc(db, "public-rewards", currentUser.uid), { activeType: newActiveType, activated: newActiveType ? true : rewardActivated }, { merge: true });
    activeType = newActiveType;
    if (newActiveType) rewardActivated = true;
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {}
};

window.toggleReward = async () => {
  if (!currentUser || ownedTypes.length === 0) return;
  const newState = !rewardActivated;
  try {
    await setDoc(doc(db, "public-rewards", currentUser.uid), { activated: newState }, { merge: true });
    rewardActivated = newState;
    renderRewardSection();
    applyProfileVipStyle();
  } catch (e) {}
};

function applyProfileVipStyle() {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;
  nameEl.className = "pf-name";
  if (activeType && rewardActivated) {
    const info = REWARD_LABELS[activeType];
    nameEl.classList.add(info ? info.css : `player-${activeType}`);
  }
}

window.redeemCode = async () => {
  const input = document.getElementById("reward-code-input");
  const msgEl = document.getElementById("reward-code-msg");
  if (!input || !currentUser || redeemInProgress) return;
  const code = input.value.trim().toUpperCase();
  if (!code) return;
  redeemInProgress = true;
  try {
    const q = query(collection(db, "reward-codes"), where("code", "==", code));
    const snap = await getDocs(q);
    if (snap.empty) { msgEl.textContent = "Code invalide."; msgEl.className = "pf-reward-msg error"; return; }
    const codeDoc = snap.docs[0];
    const codeData = codeDoc.data();
    if (codeData.used) { msgEl.textContent = "Code déjà utilisé."; msgEl.className = "pf-reward-msg error"; return; }
    const rewardType = codeData.type || "vip";
    const now = new Date().toISOString();
    await Promise.all([
      setDoc(doc(db, "reward-codes", codeDoc.id), { used: true, redeemedBy: [currentUser.uid], lastUsedAt: now }, { merge: true }),
      setDoc(doc(db, "public-rewards", currentUser.uid), { username: currentUser.name, ownedTypes: [...ownedTypes, rewardType], activeType: rewardType, activated: true }, { merge: true }),
    ]);
    ownedTypes.push(rewardType);
    activeType = rewardType;
    rewardActivated = true;
    renderRewardSection();
    applyProfileVipStyle();
    msgEl.textContent = "Code activé ! 🎉"; msgEl.className = "pf-reward-msg success";
    input.value = "";
  } catch (e) { msgEl.textContent = "Erreur."; msgEl.className = "pf-reward-msg error"; }
  finally { redeemInProgress = false; }
};

/* ── Save ── */

async function saveProfileToFirestore(username, publicIdNew) {
  const ref = doc(db, "users", currentUser.uid);
  const payload = { username, publicId: publicIdNew, updatedAt: new Date().toISOString() };
  await setDoc(ref, payload, { merge: true });
  currentUser.name = username;
  currentUser.publicId = publicIdNew;
  return true;
}

window.saveInitialProfile = async () => {
  const username = document.getElementById("setup-username")?.value.trim();
  const publicId = document.getElementById("setup-public-id")?.value.trim();
  if (username && publicId && await saveProfileToFirestore(username, publicId)) {
    showProfileView("profile-main");
    renderProfileCard();
    await refreshProfile();
  }
};

window.saveProfileEdits = async () => {
  const username = document.getElementById("edit-username")?.value.trim();
  if (username && await saveProfileToFirestore(username, currentUser.publicId)) {
    toggleEditPanel();
    renderProfileCard();
    await refreshProfile();
  }
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

window.toggleAuthModal = () => document.getElementById("auth-modal")?.classList.toggle("active");
window.handleLogin = async (p) => { try { if (p === "google") await window.loginWithGoogle(); else await window.loginWithDiscord(); toggleAuthModal(); } catch (e) {} };
window.handleLogout = () => { if (confirm("Déconnexion ?")) { window.logout(); window.location.href = "index.html"; } };
window.toggleUserDropdown = (e) => { if (e) e.stopPropagation(); document.getElementById("user-container")?.classList.toggle("open"); };

/* ── Public viewer ── */

async function showPublicProfile(targetName, publicId = null) {
  if (currentUser && (currentUser.name === targetName || (publicId && currentUser.publicId === publicId))) {
    const url = new URL(window.location);
    url.searchParams.delete("player"); url.searchParams.delete("publicId");
    window.history.replaceState({}, "", url);
    showProfileView("profile-main");
    return;
  }

  showProfileView("profile-loading");

  try {
    if (!publicId) {
      const q = query(collection(db, "public-aliases"), where("username", "==", targetName));
      const snap = await getDocs(q);
      if (!snap.empty) publicId = snap.docs[0].id;
      else {
        const q2 = query(collection(db, "public-aliases"), where("aliases", "array-contains", targetName));
        const snap2 = await getDocs(q2);
        if (!snap2.empty) publicId = snap2.docs[0].id;
      }
    }

    await loadRunsData();
    const stats = {};
    allRuns.forEach(r => {
      if (!r.player) return;
      if (!stats[r.player]) stats[r.player] = { wins: 0, maps: new Set(), runs: [], points: 0 };
      const p = stats[r.player]; p.wins++; p.maps.add(r.map); p.runs.push(r);
    });
    Object.values(stats).forEach(p => p.points = p.wins * 10 + p.maps.size * 5);

    const sorted = Object.entries(stats).sort((a,b) => b[1].points - a[1].points);
    let rank = 0;
    for (let i=0; i<sorted.length; i++) if (sorted[i][0] === targetName) { rank = i+1; break; }

    let apiSessions = [];
    if (publicId) {
      const apiData = await fetchOpenFrontPlayerData(publicId);
      apiSessions = apiData.sessions;
    }

    showProfileView("profile-public-viewer");
    document.getElementById("public-title-name").textContent = targetName;
    document.getElementById("public-profile-badge").textContent = publicId ? `Profil public (${publicId})` : "Profil public";
    
    const av = document.getElementById("public-avatar-large");
    if (av) { av.textContent = targetName.slice(0,2).toUpperCase(); av.style.background = "linear-gradient(135deg, var(--accent), var(--accentL))"; }

    if (apiSessions.length > 0) {
      document.getElementById("public-stat-global-rank").textContent = rank > 0 ? `#${rank}` : "—";
      renderStatsRow(apiSessions, "public");
      renderRecentGames(apiSessions, "public");
    } else {
      const target = stats[targetName];
      document.getElementById("public-stat-wins").textContent = target ? target.wins : 0;
      document.getElementById("public-stat-maps").textContent = target ? target.maps.size : 0;
      document.getElementById("public-stat-global-rank").textContent = rank > 0 ? `#${rank}` : "—";
      const box = document.getElementById("public-recent-games");
      if (target) box.innerHTML = target.runs.slice(-5).reverse().map(r => `<div class="feed-item" style="display:flex;justify-content:space-between;padding:12px;border-bottom:1px solid var(--border)"><span>${esc(r.map)}</span><span style="color:var(--accent)">${formatTime(r.duration_s)}</span></div>`).join("");
      else box.innerHTML = "<p style='padding:16px;text-align:center;color:var(--text3)'>Aucune donnée.</p>";
    }

    if (publicId) loadRankedGames(publicId, "public-ranked-games");
    else document.getElementById("public-ranked-games").innerHTML = "<p style='padding:16px;text-align:center;color:var(--text3)'>ID non fourni.</p>";

  } catch (e) {
    console.error(e);
    showProfileView("profile-public-viewer");
  }
}

(function() {
  const p = new URLSearchParams(window.location.search);
  if (p.get("player")) showPublicProfile(p.get("player"), p.get("publicId"));
})();

onAuthStateChanged(auth, async (user) => {
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  showProfileView("profile-loading");
  const p = new URLSearchParams(window.location.search);
  if (!user) {
    if (p.get("player")) showPublicProfile(p.get("player"), p.get("publicId"));
    else showProfileView("profile-gate");
    return;
  }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};
    if (p.get("player") && (p.get("player") === data.username || p.get("publicId") === data.publicId)) {
      const url = new URL(window.location); url.searchParams.delete("player"); url.searchParams.delete("publicId");
      window.history.replaceState({}, "", url);
    } else if (p.get("player")) { showPublicProfile(p.get("player"), p.get("publicId")); return; }
    if (!data.publicId) {
      currentUser = { uid: user.uid, avatar: user.photoURL, email: user.email };
      firestoreProfile = data;
      showProfileView("profile-setup");
      return;
    }
    firestoreProfile = data;
    currentUser = { uid: user.uid, name: data.username, publicId: data.publicId, avatar: user.photoURL, email: user.email };
    applySessionsFromFirestore(data);
    showProfileView("profile-main");
    renderProfileCard();
    await loadRunsData();
    buildLeaderboard();
    await refreshProfile();
    await loadUserReward();
    profileUnsub = onSnapshot(doc(db, "users", user.uid), (s) => {
      if (_skipNextSnapshot) { _skipNextSnapshot = false; firestoreProfile = s.data(); return; }
      firestoreProfile = s.data();
      refreshProfile();
    });
  } catch (e) { showProfileView("profile-main"); }
});

async function loadRankedGames(publicId, containerId) {
  const box = document.getElementById(containerId);
  if (!box || !publicId) return;
  box.innerHTML = `<div class="loading">Chargement...</div>`;
  try {
    const pRes = await fetch(`https://api.openfront.io/player/${publicId}`);
    const pData = await pRes.json();
    const ranked = (pData.games || []).filter(g => g.rankedType === "1v1").reverse().slice(0, 5);
    if (ranked.length === 0) { box.innerHTML = "<p style='padding:16px;text-align:center;color:var(--text3)'>Aucune partie classée.</p>"; return; }
    let html = "";
    for (const g of ranked) {
      const gRes = await fetch(`https://api.openfront.io/public/game/${g.gameId}?turns=false`);
      const gInfo = (await gRes.json()).info || await gRes.json();
      const opp = (gInfo.players || []).find(pl => pl.clientID !== g.clientId)?.username || "Inconnu";
      const won = gInfo.winner && gInfo.winner[1] === g.clientId;
      html += `<a class="pf-game" href="https://openfront.io/game/${g.gameId}" target="_blank"><div class="pf-game-icon ${won ? "won" : "lost"}">${won ? "W" : "L"}</div><div class="pf-game-body"><div class="pf-game-map">vs ${esc(opp)}</div><div class="pf-game-meta">${esc(g.map || "—")} · ${new Date(g.start).toLocaleDateString()}</div></div><div class="pf-game-link">▶</div></a>`;
    }
    box.innerHTML = html;
  } catch (e) { box.innerHTML = "<p style='padding:16px;text-align:center;color:#ef4444'>Erreur API.</p>"; }
}
