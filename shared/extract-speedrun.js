/**
 * shared/extract-speedrun.js — Mode-aware speedrun extraction.
 *
 * Exports:
 *   TIME_OFFSET_SECS  — Time offset subtracted from game duration (32s)
 *   extractSpeedrun(raw, mode) — Extract a valid speedrun from raw game data
 *     mode: "normal" | "compact" (default: "normal")
 *
 * Normal criteria:  gameMapSize="Normal", bots=400, humanPlayers>=10, reject all mods
 * Compact criteria: gameMapSize="Compact", bots=100, humanPlayers>=3, allow only isCompact mod
 */

import { normalizeMap } from "./maps.js";

export const TIME_OFFSET_SECS = 32;

/**
 * Extract a valid speedrun from raw game detail data.
 * @param {object} raw - Raw game detail from the OpenFront API
 * @param {"normal"|"compact"} mode - Extraction mode (default: "normal")
 * @returns {object|null} Extracted run object, or null if invalid
 */
export function extractSpeedrun(raw, mode = "normal") {
  const detail = raw.info;
  if (!detail) return null;
  const config = detail.config || {};

  const isCompact = mode === "compact";

  // ── Common validity criteria ────────────────────────────────────────────
  if (config.gameType !== "Public")       return null;
  if (config.gameMode !== "Free For All") return null;

  // ── Mode-specific criteria ──────────────────────────────────────────────
  if (isCompact) {
    if (config.gameMapSize !== "Compact") return null;
    if (config.bots        !== 100)       return null;
  } else {
    if (config.gameMapSize !== "Normal") return null;
    if (config.bots        !== 400)       return null;
  }

  const mods = config.publicGameModifiers || {};
  if (isCompact) {
    // Compact: only isCompact is allowed — reject any other active mod
    const allowedMods = ["isCompact"];
    const modKeys = Object.keys(mods).filter(k => mods[k]);
    for (const key of modKeys) {
      if (!allowedMods.includes(key)) return null;
    }
  } else {
    // Normal: reject all mods
    if (mods.isCompact || mods.isRandomSpawn || mods.isCrowded || mods.isHardNations || mods.isAlliancesDisabled) return null;
  }

  // ── Common cheat/mod checks ─────────────────────────────────────────────
  if (config.randomSpawn  !== false) return null;
  if (config.donateGold   !== false) return null;
  if (config.donateTroops !== false) return null;
  if (config.infiniteGold)           return null;
  if (config.infiniteTroops)         return null;
  if (config.instantBuild)           return null;
  if (config.startingGold  != null && config.startingGold  !== 0) return null;
  if (config.goldMultiplier != null && config.goldMultiplier !== 1) return null;

  // ── Player checks ───────────────────────────────────────────────────────
  const players = detail.players || [];
  const humanPlayers = players.filter(p => !p.isBot);
  const minHumans = isCompact ? 3 : 10;
  if (humanPlayers.length < minHumans) return null;

  const winner = detail.winner;
  if (!winner || !Array.isArray(winner) || winner.length < 2) return null;

  const winnerPlayer = players.find(p => p.clientID === winner[1]);
  if (!winnerPlayer?.username || winnerPlayer.isBot) return null;

  // ── Duration calculation ────────────────────────────────────────────────
  let durationSecs = null;
  if (detail.duration) {
    const d = detail.duration;
    durationSecs = d > 100_000 ? Math.round(d / 1000) : d;
  } else if (detail.start && detail.end) {
    const diff = detail.end - detail.start;
    durationSecs = diff > 100_000 ? Math.round(diff / 1000) : diff;
  }
  if (!durationSecs || durationSecs < 60) return null;
  durationSecs = Math.max(0, durationSecs - TIME_OFFSET_SECS);

  const gameId = detail.gameID || detail.gameId || detail.id;
  const mapName = normalizeMap(config.gameMap || "Unknown");

  return {
    id:         gameId,
    player:     winnerPlayer.username,
    playerId:   winnerPlayer.clientID,
    map:        mapName,
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots:       isCompact ? 100 : 400,
    players:    humanPlayers.length,
    timestamp:  detail.start
      ? new Date(detail.start > 1e10 ? detail.start : detail.start * 1000).toISOString()
      : new Date().toISOString(),
    url:        `https://openfront.io/game/${gameId}`,
  };
}
