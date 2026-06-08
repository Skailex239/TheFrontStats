import { API_BASE, openFrontFetch, warnIfNoExemption } from "./openfront-api.js";

warnIfNoExemption();

async function test() {
  const now = new Date();
  const ago = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const url = `${API_BASE}/public/games?start=${ago.toISOString()}&end=${now.toISOString()}`;
  console.log("URL:", url);

  const res = await openFrontFetch(url);
  if (!res.ok) {
    console.error("HTTP", res.status, await res.text());
    process.exit(1);
  }
  const games = await res.json();
  console.log("\nTotal games:", games.length);

  const byType = {};
  const byMode = {};
  const byPlayers = {};
  games.forEach((g) => {
    byType[g.type || "null"] = (byType[g.type || "null"] || 0) + 1;
    byMode[g.mode || "null"] = (byMode[g.mode || "null"] || 0) + 1;
    const bucket = g.numPlayers >= 10 ? "10+" : g.numPlayers >= 5 ? "5-9" : "<5";
    byPlayers[bucket] = (byPlayers[bucket] || 0) + 1;
  });

  console.log("\nBy type:", byType);
  console.log("By mode:", byMode);
  console.log("By players:", byPlayers);

  const ffa10 = games.filter((g) => g.mode === "Free For All" && g.numPlayers >= 10);
  console.log("\nFFA 10+ players:", ffa10.length);
  if (ffa10.length > 0) {
    console.log("Types of FFA 10+:", [...new Set(ffa10.map((g) => g.type))]);
    console.log("\nSample:", JSON.stringify(ffa10[0], null, 2));
  }
}

test().catch(console.error);
