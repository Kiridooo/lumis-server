const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { Pool } = require("pg");

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://lumis_db_872t_user:BlKubgH6A0pGVfrQ3ZqlpYZyC7FDYsPb@dpg-d6ok53h5pdvs73el61cg-a/lumis_db_872t",
  ssl: { rejectUnauthorized: false }
});

// Create tables if they don't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      username TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0,
      collection JSONB DEFAULT '{}'
    )
  `);
  console.log("✅ Datenbank bereit");
}

// Game state (in memory)
let gameState = {
  activeLumi: null,
  catchOpen: false,
  spawnAt: null,
};

const LUMIS = [
  { id:"foxlumi",     name:"Foxlumi",     emoji:"🦊", rarity:"common",    color:"#FF6B35", points:10  },
  { id:"moonbun",     name:"Moonbun",     emoji:"🐰", rarity:"common",    color:"#A8D8EA", points:10  },
  { id:"glowfrog",    name:"Glowfrog",    emoji:"🐸", rarity:"common",    color:"#95E1A3", points:15  },
  { id:"pebblet",     name:"Pebblet",     emoji:"🪨", rarity:"common",    color:"#B0A090", points:12  },
  { id:"stardust",    name:"Stardust",    emoji:"✨", rarity:"rare",      color:"#FFD700", points:50  },
  { id:"crystalpup",  name:"Crystalpup",  emoji:"🐺", rarity:"rare",      color:"#B8A9FF", points:60  },
  { id:"shadowcat",   name:"Shadowcat",   emoji:"🐈‍⬛", rarity:"rare",   color:"#6C63FF", points:70  },
  { id:"cosmicjelly", name:"Cosmicjelly", emoji:"🪼", rarity:"epic",      color:"#00D4FF", points:120 },
  { id:"veilwing",    name:"Veilwing",    emoji:"🦋", rarity:"epic",      color:"#FF69B4", points:130 },
  { id:"moondragon",  name:"Moondragon",  emoji:"🐉", rarity:"legendary", color:"#7B2FBE", points:300 },
  { id:"phoenix",     name:"Phoenix",     emoji:"🔥", rarity:"legendary", color:"#FF4444", points:350 },
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
  const pool2 = LUMIS.filter(l => l.rarity === tier);
  return pool2[Math.floor(Math.random() * pool2.length)];
}

function scheduleNextSpawn() {
  const delay = (160 + Math.random() * 30) * 1000;
  gameState.spawnAt = Date.now() + delay;
  setTimeout(() => {
    gameState.activeLumi = spawnRandomLumi();
    gameState.catchOpen = true;
    console.log(`✨ Lumi gespawnt: ${gameState.activeLumi.name} (${gameState.activeLumi.rarity})`);
    // Auto-close after 20 seconds
    setTimeout(() => {
      if (gameState.catchOpen) {
        console.log(`💨 ${gameState.activeLumi?.name} entkommen`);
        gameState.catchOpen = false;
        gameState.activeLumi = null;
        scheduleNextSpawn();
      }
    }, 20000);
  }, delay);
}

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

  // API: get current game state + leaderboard
  if (req.method === "GET" && pathname === "/api/state") {
    try {
      const lb = await pool.query(
        "SELECT username, points FROM players ORDER BY points DESC LIMIT 10"
      );
      sendJSON(res, {
        lumi: gameState.activeLumi,
        catchOpen: gameState.catchOpen,
        nextSpawnIn: gameState.spawnAt ? Math.max(0, Math.round((gameState.spawnAt - Date.now()) / 1000)) : 0,
        leaderboard: lb.rows,
      });
    } catch(e) {
      sendJSON(res, { error: e.message }, 500);
    }
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
      try {
        // Upsert player + update collection
        await pool.query(`
          INSERT INTO players (username, points, collection)
          VALUES ($1, $2, $3::jsonb)
          ON CONFLICT (username) DO UPDATE SET
            points = players.points + $2,
            collection = jsonb_set(
              players.collection,
              ARRAY[$4],
              (COALESCE((players.collection->>$4)::int, 0) + 1)::text::jsonb
            )
        `, [username, lumi.points, JSON.stringify({[lumi.id]: 1}), lumi.id]);
        console.log(`✅ ${username} fing ${lumi.name}`);
      } catch(e) {
        console.error("DB Fehler:", e.message);
      }
    }

    sendJSON(res, {
      success: caught,
      lumi,
      roll: Math.round(roll * 100),
      needed: Math.round(chance * 100)
    });
    return;
  }

  // API: get player data
  if (req.method === "GET" && pathname.startsWith("/api/player/")) {
    const username = decodeURIComponent(pathname.split("/api/player/")[1]);
    try {
      const r = await pool.query("SELECT * FROM players WHERE username = $1", [username]);
      const player = r.rows[0] || { points: 0, collection: {} };
      sendJSON(res, { username, points: player.points, collection: player.collection });
    } catch(e) {
      sendJSON(res, { username, points: 0, collection: {} });
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// Start
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  scheduleNextSpawn();
  server.listen(PORT, () => {
    console.log("╔════════════════════════════════╗");
    console.log("║   ✨ LUMIS SERVER GESTARTET ✨  ║");
    console.log(`║   Port: ${PORT}                    ║`);
    console.log("╚════════════════════════════════╝");
  });
});
