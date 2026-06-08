// sync-teams.js — Fetches team speedrun data from OpenFront API
// Filters: Public, 10+ players, 400 bots, Normal map, no modifiers
// Usage: node sync-teams.js

const https = require('https');
const fs = require('fs');

const API_HOST = 'api.openfront.io';
const TEAM_MODES = ['Duos', 'Trios', 'Quads'];
const DAYS_BACK = 7;
const API_LIMIT = 1000;
const DETAIL_FETCH_CAP = 150;
const RATE_MS = 400;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: API_HOST, path, headers: { 'Accept': 'application/json' }, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllGames(mode, startDate, endDate) {
  let all = [];
  let offset = 0;
  while (true) {
    const path = '/public/games?start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate) + '&mode=Team&playerTeams=' + encodeURIComponent(mode) + '&limit=' + API_LIMIT + '&offset=' + offset;
    const batch = await apiGet(path);
    if (!batch || !Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < API_LIMIT) break;
    offset += API_LIMIT;
    await delay(RATE_MS);
  }
  return all;
}

async function main() {
  console.log('🔄 Team Speedrun Sync starting...');
  console.log('Date range: last ' + DAYS_BACK + ' days');
  const result = { lastUpdate: new Date().toISOString(), duos: {}, trios: {}, quads: {} };
  const now = new Date();

  for (const mode of TEAM_MODES) {
    const key = mode === 'Duos' ? 'duos' : mode === 'Trios' ? 'trios' : 'quads';
    console.log('\n📋 Syncing ' + mode + '...');

    let allQualified = [];

    for (let d = 0; d < DAYS_BACK; d++) {
      const dayStart = new Date(now);
      dayStart.setUTCDate(dayStart.getUTCDate() - d);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCHours(23, 59, 59, 999);

      const startStr = dayStart.toISOString().slice(0, 19) + '.000Z';
      const endStr = dayEnd.toISOString().slice(0, 19) + '.999Z';

      try {
        const games = await fetchAllGames(mode, startStr, endStr);
        console.log('  [' + key + '] Day -' + d + ': ' + games.length + ' games');

        for (const g of games) {
          if (g.type !== 'Public') continue;
          if ((g.numPlayers || 0) < 10) continue;

          const dur = (new Date(g.end) - new Date(g.start)) / 1000;
          if (dur < 60 || dur > 7200) continue;

          allQualified.push({ gameId: g.game, duration_s: dur, date: g.start, numPlayers: g.numPlayers });
        }
      } catch (e) {
        console.error('  [' + key + '] Error -' + d + ': ' + e.message);
      }
      await delay(RATE_MS * 2);
    }

    allQualified.sort((a, b) => a.duration_s - b.duration_s);
    const topGames = allQualified.slice(0, DETAIL_FETCH_CAP);
    console.log('  [' + key + '] ' + allQualified.length + ' qualified, fetching top ' + topGames.length + '...');

    let fetched = 0;
    for (const g of topGames) {
      try {
        const detail = await apiGet('/public/game/' + g.gameId);
        const info = detail.info;
        const c = info.config;

        if (c.bots !== 400) continue;
        if (c.gameMapSize && c.gameMapSize !== 'Normal') continue;
        if (c.infiniteGold || c.infiniteTroops || c.instantBuild) continue;

        const winner = info.winner;
        if (!winner || winner[0] !== 'team') continue;

        const winnerIds = winner.slice(2);
        const winnerPlayers = info.players.filter(p => winnerIds.includes(p.clientID));
        if (!winnerPlayers.length) continue;

        const map = c.gameMap;
        if (!result[key][map]) result[key][map] = [];

        result[key][map].push({
          players: winnerPlayers.map(p => ({
            username: p.username,
            clientID: p.clientID,
            clanTag: p.clanTag || null
          })),
          duration_s: info.duration,
          date: info.start,
          gameId: g.gameId,
          difficulty: c.difficulty,
          numPlayers: info.players.length
        });

        fetched++;
      } catch (e) { /* skip */ }
      await delay(RATE_MS);
    }

    let totalRuns = 0, totalMaps = 0;
    for (const map in result[key]) {
      result[key][map].sort((a, b) => a.duration_s - b.duration_s);
      result[key][map] = result[key][map].slice(0, 25);
      totalRuns += result[key][map].length;
      totalMaps++;
    }
    console.log('  ✅ ' + mode + ': ' + totalMaps + ' maps, ' + totalRuns + ' runs');
  }

  fs.writeFileSync('teams.json', JSON.stringify(result, null, 2));
  const dm = Object.keys(result.duos).length;
  const tr = Object.keys(result.trios).length;
  const qd = Object.keys(result.quads).length;
  console.log('\n✅ teams.json written! (' + dm + ' duo, ' + tr + ' trio, ' + qd + ' quad maps)');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
