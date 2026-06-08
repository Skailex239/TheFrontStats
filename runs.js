const $ = (id) => document.getElementById(id);

const connectedUsernames = new Set();

function formatTime(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) return '\u2014';
  const m = Math.floor(durationSeconds / 60);
  const s = String(durationSeconds % 60).padStart(2, '0');
  return m + 'm' + s + 's';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function(s) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[s];
  });
}

function safeText(x) {
  return x == null ? '' : String(x);
}

function makeRankBadge(rank) {
  const cls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  return '<span class="global-rank ' + cls + '">' + rank + '</span>';
}

// Load connected usernames from Firebase public-rewards and public-aliases
async function loadConnectedUsernames() {
  try {
    var mod = await import('./auth.js');
    var db = mod.db;
    var collection = mod.collection;
    var onSnapshot = mod.onSnapshot;

    // From public-rewards
    onSnapshot(collection(db, 'public-rewards'), function(snap) {
      snap.forEach(function(docSnap) {
        var data = docSnap.data();
        if (data.username) connectedUsernames.add(data.username);
      });
    }, function() {});

    // From public-aliases
    onSnapshot(collection(db, 'public-aliases'), function(snap) {
      snap.forEach(function(docSnap) {
        var data = docSnap.data();
        if (data.username) connectedUsernames.add(data.username);
      });
    }, function() {});
  } catch (e) {
    console.warn('[runs] Could not load connected usernames:', e);
  }
}

function handlePlayerClick(name) {
  if (connectedUsernames.has(name)) {
    window.location.href = 'profile.html?player=' + encodeURIComponent(name);
  } else {
    showToast("Ce joueur n'est pas encore connecté à un compte TheFrontStats.", "warning");
  }
}
window.handlePlayerClick = handlePlayerClick;

async function loadTopRuns({ limit, windowDays }) {
  const meta = $('meta');
  const status = $('status');
  const errorBox = $('errorBox');
  const tbody = $('rows');
  const generatedMeta = $('generatedMeta');

  tbody.innerHTML = '';
  errorBox.hidden = true;

  status.textContent = 'Chargement\u2026';
  meta.textContent = 'Fen\u00eatre: ' + windowDays + ' jours \u2022 limite: ' + limit;

  const startedAt = Date.now();

  try {
    // Fetch runs.json.gz directly (same as app.js) instead of /api/top-runs
    let allRunsData;
    try {
      const ds = new DecompressionStream('gzip');
      const gzRes = await fetch('runs.json.gz', { cache: 'no-store' });
      if (!gzRes.ok) throw new Error('HTTP ' + gzRes.status);
      const decompressed = gzRes.body.pipeThrough(ds);
      allRunsData = await new Response(decompressed).json();
    } catch (gzErr) {
      // Fallback to uncompressed file
      const plainRes = await fetch('runs.json', { cache: 'no-store' });
      if (!plainRes.ok) throw new Error('Impossible de charger runs.json');
      allRunsData = await plainRes.json();
    }

    // Support both formats: {runs:[], totalCount} and plain array
    const rawRuns = Array.isArray(allRunsData) ? allRunsData : (allRunsData.runs || []);

    // Filter by windowDays
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const filtered = rawRuns.filter(function(r) {
      if (!r.timestamp) return false;
      return (now - new Date(r.timestamp).getTime()) <= windowMs;
    });

    // Sort by date descending, take top 'limit'
    filtered.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    const runs = filtered.slice(0, limit);

    status.textContent = runs.length ? '' : 'Aucun run trouv\u00e9 dans les ' + windowDays + ' derniers jours.';

    const frag = document.createDocumentFragment();
    runs.forEach(function(r, idx) {
      const rank = idx + 1;

      const tr = document.createElement('tr');

      const tdRank = document.createElement('td');
      tdRank.className = 'global-rank-wrap';
      tdRank.innerHTML = makeRankBadge(rank);

      const tdPlayer = document.createElement('td');
      tdPlayer.className = 'global-player';
      var playerName = r.player || '\u2014';
      if (connectedUsernames.has(playerName)) {
        tdPlayer.innerHTML = '<a href="#" onclick="handlePlayerClick(\'' + escapeHtml(playerName).replace(/'/g, "\\'") + "');return false\" style=\"cursor:pointer;text-decoration:underline;color:var(--orange)\">" + escapeHtml(playerName) + '</a>';
      } else {
        tdPlayer.innerHTML = '<a href="#" onclick="handlePlayerClick(\'' + escapeHtml(playerName).replace(/'/g, "\\'") + "');return false\" style=\"cursor:pointer;text-decoration:none\">" + escapeHtml(playerName) + '</a>';
      }

      const tdMap = document.createElement('td');
      tdMap.innerHTML = escapeHtml(r.map || '\u2014');

      const tdTime = document.createElement('td');
      tdTime.innerHTML = '<span class="run-runtime">' + escapeHtml(formatTime(r.duration_s)) + '</span>';

      const tdDiff = document.createElement('td');
      tdDiff.textContent = safeText(r.difficulty) || '\u2014';

      const tdPlayers = document.createElement('td');
      tdPlayers.textContent = String(r.players != null ? r.players : '');

      const tdDate = document.createElement('td');
      tdDate.textContent = r.timestamp ? new Date(r.timestamp).toLocaleString('fr-FR') : '';

      tr.append(tdRank, tdPlayer, tdMap, tdTime, tdDiff, tdPlayers, tdDate);
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);

    const totalInFile = allRunsData.totalCount || rawRuns.length;
    const ms = Date.now() - startedAt;

    meta.textContent = '';
    generatedMeta.textContent = 'Top ' + runs.length + ' sur ' + filtered.length + ' runs (' + windowDays + 'j) \u2022 Total: ' + totalInFile.toLocaleString('fr') + ' \u2022 ' + ms + 'ms';
  } catch (e) {
    status.textContent = '';
    const message = e && e.message ? e.message : String(e);

    errorBox.hidden = false;
    errorBox.innerHTML =
      '<div class="runs-error-title">Erreur</div>' +
      '<div class="runs-error-msg">' + escapeHtml(message) + '</div>';

    meta.textContent = '';
    generatedMeta.textContent = '';
  }
}

function readControls() {
  const limit = Number($('limit') && $('limit').value ? $('limit').value : 20);
  const windowDays = Number($('windowDays') && $('windowDays').value ? $('windowDays').value : 30);

  return {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20,
    windowDays: Number.isFinite(windowDays) ? Math.max(1, Math.min(370, windowDays)) : 30,
  };
}

async function bootstrapRunsPage() {
  // Start loading connected usernames in background
  loadConnectedUsernames();

  const { limit, windowDays } = readControls();
  await loadTopRuns({ limit, windowDays });

  $('refreshBtn') && $('refreshBtn').addEventListener('click', async function() {
    const v = readControls();
    await loadTopRuns(v);
  });

  ['limit', 'windowDays'].forEach(function(id) {
    $(id) && $(id).addEventListener('keydown', async function(ev) {
      if (ev.key === 'Enter') {
        const v = readControls();
        await loadTopRuns(v);
      }
    });
  });
}

bootstrapRunsPage();
