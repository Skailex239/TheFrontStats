/**
 * profile.js — Profile page logic for TheFrontStats.
 *
 * Flow:
 *   onAuthStateChanged →
 *     • no user                       → show #profile-gate
 *     • user, no Firestore profile    → show #profile-setup (ownership verification)
 *     • user, profile with publicId   → fetch OpenFront stats → show #profile-main
 *
 * Stats are fetched from `https://api.openfront.io/public/player/{publicId}` via
 * fetchOpenFront (handles CORS proxy). ELO is read from local `ranked.json`.
 * Recent games (last 5) get an additional `/public/game/{gameId}` fetch to
 * determine win/loss based on the `winner` array (clientIDs of winners).
 */

import {
  auth, db, doc, getDoc, setDoc,
  onAuthStateChanged,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js";

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;

/* ── Helpers ── */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

function showView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-active", id === view);
  });
}

function formatDateShort(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function setStat(id, value, muted = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null ? "—" : String(value);
  el.classList.toggle("muted", muted);
}

/* ── Auth state ── */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentProfile = null;
    updateSidebarUI(null);
    showView("profile-gate");
    return;
  }

  currentUser = user;

  // Read Firestore profile
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.error("[profile] Firestore read error:", e);
    showToast("Erreur de lecture du profil (Firestore).", "error");
  }

  currentProfile = profile;
  updateSidebarUI(user, profile);

  if (!profile || !profile.publicId) {
    // New user → setup form
    showView("profile-setup");
    return;
  }

  // Returning user with publicId → fetch & display stats
  showView("profile-main");
  renderHero(user, profile);
  await loadStats(profile.publicId);
});

/* ── Sidebar / dropdown UI ── */

function updateSidebarUI(user, profile) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!user) {
    if (loginBtn) loginBtn.style.display = "flex";
    if (userContainer) { userContainer.style.display = "none"; userContainer.classList.remove("open"); }
    return;
  }
  if (loginBtn) loginBtn.style.display = "none";
  if (userContainer) userContainer.style.display = "block";

  const name = profile?.username || user.displayName || user.email || "Joueur";
  const publicId = profile?.publicId || "Non lié";

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("user-display-name", name);
  setText("user-public-id-side", publicId !== "Non lié" ? publicId : "En ligne");
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${esc(user.photoURL)}" alt="${esc(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = (name || "U").substring(0, 2).toUpperCase();
      avatarEl.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
    }
  }
}

/* ── Main view: hero ── */

function renderHero(user, profile) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) nameEl.textContent = profile.username || user.displayName || "Joueur";

  const badgeEl = document.getElementById("profile-public-badge");
  if (badgeEl) badgeEl.textContent = "Public ID: " + (profile.publicId || "—");

  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    // Use PDP.png as the avatar image (instead of default letter)
    avatarEl.innerHTML = `<img src="PDP.png" alt="${esc(profile.username || 'avatar')}" style="width:100%;height:100%;object-fit:cover">`;
  }
}

/* ── Main view: load stats ── */

async function loadStats(publicId) {
  // Reset stats list to loading
  setText("stat-week-rank", "This week rank: …");
  setText("stat-week-score", "This week score: …");
  setText("stat-alltime", "All-time score: …");
  const recentEl = document.getElementById("profile-recent-games");
  if (recentEl) recentEl.innerHTML = `<div class="pf-empty">Chargement…</div>`;
  hideError();

  // Kick off ELO lookup (ranked.json) in parallel
  const eloPromise = getRankedEntry(publicId);

  let playerData;
  try {
    playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
  } catch (e) {
    console.error("[profile] OpenFront API error:", e);
    showError(`Impossible de charger les statistiques depuis l'API OpenFront.`);
    setText("stat-week-rank", "This week rank: —");
    setText("stat-week-score", "This week score: —");
    setText("stat-alltime", "All-time score: —");
    return;
  }

  if (!playerData) {
    showError("Réponse vide de l'API OpenFront.");
    return;
  }

  const games = Array.isArray(playerData.games) ? playerData.games : [];
  const stats = computeStats(games, playerData.stats || {});

  // Compute week stats (games in last 7 days)
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const weekGames = games.filter(g => {
    const t = new Date(g.start || 0).getTime();
    return !isNaN(t) && t >= weekAgo && t <= now;
  });
  const weekWins = weekGames.length; // approximate: count week games as "score"
  const weekRank = "—"; // not available without global calc

  // All-time score: wins * 1 + games played (simple heuristic)
  const allTimeScore = stats.wins * 4 + (stats.total - stats.wins);

  // Breakdown by mode (from stats tree)
  const breakdown = computeModeBreakdown(playerData.stats || {});
  const detail = [];
  if (breakdown.FFA) detail.push("FFA: " + breakdown.FFA);
  if (breakdown.Team) detail.push("Team: " + breakdown.Team);
  if (breakdown.Duos) detail.push("Duos: " + breakdown.Duos);
  if (breakdown.Trios) detail.push("Trios: " + breakdown.Trios);
  if (breakdown.Quads) detail.push("Quads: " + breakdown.Quads);
  const detailStr = detail.length ? " (" + detail.join(", ") + ")" : "";

  setText("stat-week-rank", `This week rank: #${weekRank}`);
  setText("stat-week-score", `This week score: ${weekWins}`);
  setText("stat-alltime", `All-time score: ${allTimeScore} (${stats.wins} wins${detailStr})`);

  // ELO from ranked.json
  const ranked = await eloPromise;
  const eloLine = document.getElementById("stat-elo-line");
  if (eloLine) {
    if (ranked && ranked.elo != null) {
      eloLine.textContent = `ELO: ${ranked.elo} (Peak: ${ranked.peakElo ?? '—'})`;
      eloLine.style.display = "list-item";
    } else {
      eloLine.style.display = "none";
    }
  }

  // Recent games (last 5) — fetch each game to determine win/loss
  renderRecentGames(games, publicId);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function computeModeBreakdown(statsTree) {
  const out = { FFA: 0, Team: 0, Duos: 0, Trios: 0, Quads: 0 };
  if (!statsTree || typeof statsTree !== "object") return out;
  for (const catKey of Object.keys(statsTree)) {
    const cat = statsTree[catKey];
    if (!cat || typeof cat !== "object") continue;
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;
      let wins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) {
          wins += parseInt(diff.wins, 10) || 0;
        }
      }
      if (modeKey === "Free For All") out.FFA += wins;
      else if (modeKey === "Team") {
        // Try to break down by playerTeams if available
        out.Team += wins;
      }
    }
  }
  return out;
}

function computeStats(games, statsTree) {
  // Wins: sum all "wins" fields across the stats tree (Private/Public/Ranked → mode → difficulty)
  let wins = 0;
  let total = 0;
  if (statsTree && typeof statsTree === "object") {
    for (const catKey of Object.keys(statsTree)) {
      const cat = statsTree[catKey];
      if (!cat || typeof cat !== "object") continue;
      for (const modeKey of Object.keys(cat)) {
        const mode = cat[modeKey];
        if (!mode || typeof mode !== "object") continue;
        for (const diffKey of Object.keys(mode)) {
          const diff = mode[diffKey];
          if (!diff || typeof diff !== "object") continue;
          if (diff.wins != null) wins += parseInt(diff.wins, 10) || 0;
          if (diff.total != null) total += parseInt(diff.total, 10) || 0;
          else if (diff.wins != null && diff.losses != null) {
            total += (parseInt(diff.wins, 10) || 0) + (parseInt(diff.losses, 10) || 0);
          }
        }
      }
    }
  }

  // Fallback: if stats tree has no totals, use games.length
  if (total === 0 && games.length > 0) total = games.length;

  // Unique maps + favourite map
  const mapCounts = {};
  let lastGame = null;
  for (const g of games) {
    if (g.map) mapCounts[g.map] = (mapCounts[g.map] || 0) + 1;
    if (g.start) {
      const d = new Date(g.start).getTime();
      if (!isNaN(d) && (lastGame === null || d > lastGame)) lastGame = d;
    }
  }
  const uniqueMaps = Object.keys(mapCounts).length;
  let favMap = null;
  let favCount = 0;
  for (const [m, c] of Object.entries(mapCounts)) {
    if (c > favCount) { favMap = m; favCount = c; }
  }
  const lastGameIso = lastGame ? new Date(lastGame).toISOString() : null;

  return { wins, total, uniqueMaps, favMap, lastGame: lastGameIso };
}

async function getRankedEntry(publicId) {
  if (_rankedCache === null) {
    try {
      const res = await fetch("ranked.json", { cache: "no-store" });
      if (res.ok) _rankedCache = await res.json();
      else _rankedCache = {};
    } catch (e) {
      console.warn("[profile] ranked.json load failed:", e);
      _rankedCache = {};
    }
  }
  const list = (_rankedCache && Array.isArray(_rankedCache["1v1"])) ? _rankedCache["1v1"] : [];
  return list.find((p) => p && p.public_id === publicId) || null;
}

function showError(msg) {
  const el = document.getElementById("profile-api-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("profile-api-error");
  if (el) el.style.display = "none";
}

/* ── Recent games (last 5) ── */

async function renderRecentGames(games, publicId) {
  const container = document.getElementById("profile-recent-games");
  if (!container) return;

  // Sort by start date desc, take last 5
  const sorted = games
    .slice()
    .sort((a, b) => new Date(b.start || 0).getTime() - new Date(a.start || 0).getTime())
    .slice(0, 5);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
    return;
  }

  // Initial render with loading result badges
  container.innerHTML = sorted.map((g, i) => `
    <div class="pf-game-card loss" data-game-idx="${i}">
      <div class="pf-game-id">${esc(g.gameId || "—")}</div>
      <div class="pf-game-result" data-result>…</div>
      <div class="pf-game-meta">${formatDateTime(g.start)}</div>
      <div class="pf-game-meta">${esc(g.map || "Carte inconnue")}</div>
      <div class="pf-game-meta">${esc(g.mode || "—")}</div>
      <a class="pf-game-replay" href="https://openfront.io/game/${encodeURIComponent(g.gameId)}" target="_blank" rel="noopener">Watch replay</a>
    </div>
  `).join("");

  // Fetch each game's result in parallel
  sorted.forEach(async (g, i) => {
    const card = container.querySelector(`[data-game-idx="${i}"]`);
    if (!card) return;
    const resultEl = card.querySelector("[data-result]");
    let isWin = null;
    try {
      isWin = await checkGameWin(g.gameId, g.clientId);
    } catch (e) {
      console.warn("[profile] game lookup failed:", g.gameId, e);
    }
    if (resultEl) {
      if (isWin === true) {
        resultEl.textContent = "WIN";
        card.classList.remove("loss");
        card.classList.add("win");
        // Add points badge for wins
        const ptsEl = document.createElement("div");
        ptsEl.className = "pf-game-pts";
        ptsEl.textContent = "+4 pts";
        card.insertBefore(ptsEl, card.querySelector(".pf-game-replay"));
      } else if (isWin === false) {
        resultEl.textContent = "LOSS";
      } else {
        resultEl.textContent = "N/A";
      }
    }
  });
}

/**
 * Check whether the given clientId is among the winners of the given game.
 * OpenFront `/public/game/{gameId}` returns `info.winner` as
 * `[type, name, ...clientIDs]`.
 */
async function checkGameWin(gameId, clientId) {
  if (!gameId || !clientId) return null;
  const data = await fetchOpenFront(`/public/game/${encodeURIComponent(gameId)}`);
  const winner = data?.info?.winner;
  if (!Array.isArray(winner) || winner.length < 3) return null;
  // winner[0] = "team" | "player", winner[1] = name, winner[2..] = clientIDs
  const winnerIds = winner.slice(2);
  return winnerIds.includes(clientId);
}

/* ── Setup: ownership verification ── */

window.startOwnershipVerification = async () => {
  if (!currentUser) {
    showToast("Veuillez vous connecter d'abord.", "warning");
    return;
  }
  const usernameInput = document.getElementById("setup-username");
  const publicIdInput = document.getElementById("setup-public-id");
  const username = (usernameInput?.value || "").trim();
  const publicId = (publicIdInput?.value || "").trim();

  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast("Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.", "warning");
    return;
  }

  // If user already has a different publicId, refuse change
  try {
    if (currentProfile && currentProfile.publicId && currentProfile.publicId !== publicId) {
      showToast("Le Public ID OpenFront ne peut plus être modifié.", "error");
      return;
    }
  } catch (e) { /* non-blocking */ }

  // Verify publicId exists on OpenFront
  showToast("Vérification du Public ID…", "info", 3000);
  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.games) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
  } catch (e) {
    showToast("Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.", "error", 6000);
    console.error("[ownership] API check failed:", e);
    return;
  }

  // Generate TFS-XXXX challenge code
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  _ownershipCode = "TFS-";
  for (let i = 0; i < 4; i++) _ownershipCode += chars[Math.floor(Math.random() * chars.length)];
  _ownershipPublicId = publicId;
  _ownershipUsername = username;

  // Switch to step 2
  document.getElementById("profile-setup-step1").style.display = "none";
  document.getElementById("profile-setup-step2").style.display = "block";
  const codeEl = document.getElementById("ownership-code");
  const exEl = document.getElementById("ownership-example");
  if (codeEl) codeEl.textContent = _ownershipCode;
  if (exEl) exEl.textContent = _ownershipCode + " " + username;
  showToast("Code généré. Suivez les instructions ci-dessous.", "info");
};

window.confirmOwnershipVerification = async () => {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || "Confirmer";
  if (btn) { btn.disabled = true; btn.textContent = "Vérification…"; }

  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}`);
    const games = playerData?.games || [];
    let found = games.some((g) => g.username && g.username.includes(_ownershipCode));
    if (!found && playerData?.user?.username && playerData.user.username.includes(_ownershipCode)) {
      found = true;
    }
    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.", "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    // Verified → save to Firestore
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = () => {
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
};

async function saveUserProfile(username, publicId) {
  if (!currentUser) throw new Error("No authenticated user");
  try {
    const existing = currentProfile || {};
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email || null,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    currentProfile = { ...(currentProfile || {}), username, publicId, verified: true };
    showToast("Profil vérifié et enregistré avec succès !", "success");

    // Reset setup form
    window.cancelOwnershipVerification();
    updateSidebarUI(currentUser, currentProfile);

    // Switch to main view and load stats
    showView("profile-main");
    renderHero(currentUser, currentProfile);
    await loadStats(publicId);
  } catch (e) {
    console.error("[profile] Save profile error:", e);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
    throw e;
  }
}

/* ── Sidebar / auth modal handlers ── */

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.handleLogin = async function (provider) {
  if (window._loginInProgress) return;
  window._loginInProgress = true;
  const authBtns = document.querySelectorAll(".auth-btn");
  authBtns.forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    // Close modal on success — onAuthStateChanged will switch view
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[profile] Login error:", e);
  } finally {
    window._loginInProgress = false;
    authBtns.forEach((b) => { b.disabled = false; b.style.opacity = ""; });
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm("Voulez-vous vous déconnecter ?")) return;
  try { await window.logout(); } catch (e) { console.warn("[profile] logout error:", e); }
  currentUser = null;
  currentProfile = null;
  updateSidebarUI(null);
  showView("profile-gate");
};

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const c = document.getElementById("user-container");
  if (c) c.classList.toggle("open");
};

window.closeUserDropdown = function () {
  const c = document.getElementById("user-container");
  if (c) c.classList.remove("open");
};

window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  // Already on profile page — just close dropdown
  window.closeUserDropdown();
};

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});
