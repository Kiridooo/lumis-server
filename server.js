const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// Simple JSON-file database (no extra packages needed)
const DB_FILE = path.join(__dirname, "lumis-data.json");

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { players: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { players: {} }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Game state (in memory, resets each stream session)
let gameState = {
  activeLumi: null,
  catchOpen: false,
  spawnAt: null,
};

const LUMIS = [
  { id:"foxlumi",    name:"Foxlumi",    emoji:"🦊", rarity:"common",    color:"#FF6B35", points:10  },
  { id:"moonbun",    name:"Moonbun",    emoji:"🐰", rarity:"common",    color:"#A8D8EA", points:10  },
  { id:"glowfrog",   name:"Glowfrog",   emoji:"🐸", rarity:"common",    color:"#95E1A3", points:15  },
  { id:"pebblet",    name:"Pebblet",    emoji:"🪨", rarity:"common",    color:"#B0A090", points:12  },
  { id:"stardust",   name:"Stardust",   emoji:"✨", rarity:"rare",      color:"#FFD700", points:50  },
  { id:"crystalpup", name:"Crystalpup", emoji:"🐺", rarity:"rare",      color:"#B8A9FF", points:60  },
  { id:"shadowcat",  name:"Shadowcat",  emoji:"🐈‍⬛", rarity:"rare",   color:"#6C63FF", points:70  },
  { id:"cosmicjelly",name:"Cosmicjelly",emoji:"🪼", rarity:"epic",      color:"#00D4FF", points:120 },
  { id:"veilwing",   name:"Veilwing",   emoji:"🦋", rarity:"epic",      color:"#FF69B4", points:130 },
  { id:"moondragon", name:"Moondragon", emoji:"🐉", rarity:"legendary", color:"#7B2FBE", points:300 },
  { id:"phoenix",    name:"Phoenix",    emoji:"🔥", rarity:"legendary", color:"#FF4444", points:350 },
];

const RARITY_WEIGHTS = { common:70, rare:22, epic:6, legendary:2 };
const CATCH_CHANCES  = { common:0.70, rare:0.22, epic:0.06, legendary:0.02 };

function spawnRandomLumi() {
  const roll = Math.random() * 100;
  let cum = 0, tier = "common";
  for (const [r, w] of Object.entries(RARITY_WEIGHTS)) {
    cum += w;
    if (roll < cum) { tier = r; break; }
  }
  const pool = LUMIS.filter(l => l.rarity === tier);
  return pool[Math.floor(Math.random() * pool.length)];
}

function scheduleNextSpawn() {
  const delay = (160 + Math.random() * 30) * 1000;
  gameState.spawnAt = Date.now() + delay;
  setTimeout(() => {
    gameState.activeLumi = spawnRandomLumi();
    gameState.catchOpen = true;
    // Auto-close after 20 seconds
    setTimeout(() => {
      if (gameState.catchOpen) {
        gameState.catchOpen = false;
        gameState.activeLumi = null;
        scheduleNextSpawn();
      }
    }, 20000);
  }, delay);
}

// Start first spawn
scheduleNextSpawn();

// CORS helper
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJSON(res, data, status=200) {
  setCORS(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === "OPTIONS") { setCORS(res); res.writeHead(204); res.end(); return; }

  // Serve frontend
  if (req.method === "GET" && pathname === "/") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // API: get current game state
  if (req.method === "GET" && pathname === "/api/state") {
    const db = loadDB();
    const leaderboard = Object.entries(db.players)
      .map(([name, d]) => ({ name, points: d.points, caught: Object.keys(d.collection).length }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    sendJSON(res, {
      lumi: gameState.activeLumi,
      catchOpen: gameState.catchOpen,
      nextSpawnIn: gameState.spawnAt ? Math.max(0, Math.round((gameState.spawnAt - Date.now()) / 1000)) : 0,
      leaderboard,
    });
    return;
  }

  // API: try to catch
  if (req.method === "POST" && pathname === "/api/catch") {
    const body = await readBody(req);
    const username = (body.username || "").trim().slice(0, 32);
    if (!username) return sendJSON(res, { success: false, reason: "no_username" });
    if (!gameState.catchOpen || !gameState.activeLumi) return sendJSON(res, { success: false, reason: "no_lumi" });

    const lumi = gameState.activeLumi;
    const roll = Math.random();
    const chance = CATCH_CHANCES[lumi.rarity];
    const caught = roll < chance;

    if (caught) {
      const db = loadDB();
      if (!db.players[username]) db.players[username] = { points: 0, collection: {} };
      db.players[username].points += lumi.points;
      db.players[username].collection[lumi.id] = (db.players[username].collection[lumi.id] || 0) + 1;
      saveDB(db);
    }

    sendJSON(res, { success: caught, lumi, roll: Math.round(roll * 100), needed: Math.round(chance * 100) });
    return;
  }

  // API: get player data
  if (req.method === "GET" && pathname.startsWith("/api/player/")) {
    const username = decodeURIComponent(pathname.split("/api/player/")[1]);
    const db = loadDB();
    const player = db.players[username] || { points: 0, collection: {} };
    sendJSON(res, { username, ...player });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(3000, () => {
  console.log("╔════════════════════════════════╗");
  console.log("║   ✨ LUMIS SERVER GESTARTET ✨  ║");
  console.log("║   http://localhost:3000         ║");
  console.log("╚════════════════════════════════╝");
  console.log("Server läuft – bereit zum Streamen!");
});
