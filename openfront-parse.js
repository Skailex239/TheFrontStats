/** Parsing réponses API OpenFront (navigateur + Node). */

export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    gameId: raw.gameId || raw.game || raw.id || null,
    start: raw.start || raw.gameStart || null,
    end: raw.end || raw.gameEnd || null,
    username: raw.username || null,
    clientId: raw.clientId || null,
    clanTag: raw.clanTag || null,
    map: raw.map || raw.gameMap || null,
    mode: raw.mode || raw.gameMode || null,
    type: raw.type || raw.gameType || null,
    difficulty: raw.difficulty || null,
    hasWon: raw.hasWon === true,
  };
}

export function parseSessionsPayload(raw, playerInfo) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    list = raw.sessions || raw.results || raw.data || raw.games || [];
  }

  const metaByGame = new Map();
  (playerInfo?.games || []).forEach((g) => {
    if (g?.gameId) metaByGame.set(g.gameId, g);
  });

  return list
    .map((s) => normalizeSession({ ...metaByGame.get(s.gameId), ...s }))
    .filter((s) => s && s.gameId);
}
