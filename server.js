// =====================================================
// MOTO RACE - serveur de salons persistants
// Node.js + WebSocket. Rotation auto des maps toutes les 5 min.
// =====================================================

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// === Config ===
const NUM_MAPS = 25;
const MAP_DURATION_MS = 5 * 60 * 1000;   // 5 min de course
const TRANSITION_MS = 12 * 1000;          // 12 sec entre 2 maps (annonce des scores)

const app = express();
// Sert le client (jeu) depuis public/index.html
app.use(express.static(__dirname + '/public'));
app.get('/status', (req, res) => {
  res.send(`
    <html><body style="font-family: monospace; background: #1a2030; color: #ff5533; padding: 40px">
    <h1>🏍 Moto Race Server</h1>
    <p>Salons actifs : ${rooms.size}</p>
    <p>Joueurs connectés : ${totalPlayers()}</p>
    <p>Map actuelle (salon "main") : ${rooms.get('main')?.currentMapIdx ?? '—'}</p>
    <p><a href="/" style="color:#ffdd44">→ Lancer le jeu</a></p>
    </body></html>
  `);
});
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, players: totalPlayers() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === État des salons ===
const rooms = new Map();

function totalPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const room = {
      id: roomId,
      currentMapIdx: 0,
      mapStartedAt: Date.now(),
      inTransition: false,
      transitionEndsAt: null,
      players: new Map(),  // ws -> playerData
      tickInterval: null
    };
    rooms.set(roomId, room);
    startRoomLoop(room);
    log(`📦 Nouveau salon "${roomId}"`);
  }
  return rooms.get(roomId);
}

function destroyRoom(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  rooms.delete(room.id);
  log(`💀 Salon "${room.id}" supprimé`);
}

// Le salon principal "main" doit toujours exister et tourner même sans joueurs
function ensureMainRoom() {
  if (!rooms.has('main')) {
    getOrCreateRoom('main');
  }
}

function broadcast(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const [ws, p] of room.players) {
    if (ws !== excludeWs && ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch (e) {}
    }
  }
}

function startNewMap(room) {
  room.currentMapIdx = (room.currentMapIdx + 1) % NUM_MAPS;
  room.mapStartedAt = Date.now();
  room.inTransition = false;
  room.transitionEndsAt = null;
  // Reset des bests de session
  for (const p of room.players.values()) {
    p.sessionBest = null;
    p.runCount = 0;
  }
  broadcast(room, {
    type: 'mapStart',
    currentMapIdx: room.currentMapIdx,
    mapStartedAt: room.mapStartedAt,
    mapDuration: MAP_DURATION_MS
  });
  log(`🗺  Salon "${room.id}" : nouvelle map ${room.currentMapIdx}`);
}

function endCurrentMap(room) {
  room.inTransition = true;
  room.transitionEndsAt = Date.now() + TRANSITION_MS;

  // Top 5 de cette map
  const scores = Array.from(room.players.values())
    .filter(p => p.sessionBest !== null && p.sessionBest !== undefined)
    .map(p => ({ pseudo: p.pseudo, time: p.sessionBest }))
    .sort((a, b) => a.time - b.time)
    .slice(0, 5);

  broadcast(room, {
    type: 'mapEnd',
    mapIdx: room.currentMapIdx,
    scores,
    nextMapAt: room.transitionEndsAt,
    nextMapIdx: (room.currentMapIdx + 1) % NUM_MAPS
  });
  log(`🏁 Salon "${room.id}" : fin map ${room.currentMapIdx}, ${scores.length} score(s)`);
}

function startRoomLoop(room) {
  room.tickInterval = setInterval(() => {
    const now = Date.now();
    if (room.inTransition) {
      if (now >= room.transitionEndsAt) {
        startNewMap(room);
      }
    } else {
      const elapsed = now - room.mapStartedAt;
      if (elapsed >= MAP_DURATION_MS) {
        endCurrentMap(room);
      }
    }
  }, 500);
}

function nextPlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

// === Connexions WebSocket ===
wss.on('connection', (ws, req) => {
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'join') {
      const roomId = (msg.room || 'main').slice(0, 24);
      room = getOrCreateRoom(roomId);
      player = {
        id: nextPlayerId(),
        pseudo: (msg.pseudo || 'anonyme').slice(0, 14),
        x: 0, y: 0, a: 0, wba: 0, wfa: 0,
        sessionBest: null,
        runCount: 0,
        finished: false,
        crashed: false
      };
      room.players.set(ws, player);

      // Envoie l'état au nouveau joueur
      ws.send(JSON.stringify({
        type: 'joined',
        myId: player.id,
        room: room.id,
        currentMapIdx: room.currentMapIdx,
        mapStartedAt: room.mapStartedAt,
        mapDuration: MAP_DURATION_MS,
        inTransition: room.inTransition,
        transitionEndsAt: room.transitionEndsAt,
        players: Array.from(room.players.values())
          .filter(p => p.id !== player.id)
          .map(p => ({ id: p.id, pseudo: p.pseudo, sessionBest: p.sessionBest }))
      }));
      // Notifie les autres
      broadcast(room, {
        type: 'playerJoined',
        id: player.id,
        pseudo: player.pseudo
      }, ws);
      log(`➕ ${player.pseudo} (${player.id}) rejoint "${room.id}" — ${room.players.size} joueur(s)`);
      return;
    }

    if (!player || !room) return;

    if (msg.type === 'pos') {
      player.x = msg.x; player.y = msg.y; player.a = msg.a;
      player.wba = msg.wba; player.wfa = msg.wfa;
      player.finished = !!msg.finished;
      player.crashed = !!msg.crashed;
      broadcast(room, {
        type: 'pos',
        id: player.id,
        x: msg.x, y: msg.y, a: msg.a,
        wba: msg.wba, wfa: msg.wfa,
        crashed: msg.crashed, finished: msg.finished,
        sessionBest: player.sessionBest
      }, ws);
    } else if (msg.type === 'finished') {
      const t = parseFloat(msg.time);
      if (!isNaN(t)) {
        if (player.sessionBest === null || t < player.sessionBest) {
          player.sessionBest = t;
        }
        player.runCount++;
        broadcast(room, {
          type: 'finished',
          id: player.id,
          pseudo: player.pseudo,
          time: t,
          sessionBest: player.sessionBest
        }, ws);
      }
    } else if (msg.type === 'restart') {
      player.runCount++;
      broadcast(room, {
        type: 'restart',
        id: player.id
      }, ws);
    } else if (msg.type === 'pseudo') {
      const newPseudo = (msg.pseudo || '').slice(0, 14).trim();
      if (newPseudo) {
        player.pseudo = newPseudo;
        broadcast(room, {
          type: 'pseudo',
          id: player.id,
          pseudo: player.pseudo
        });
      }
    }
  });

  ws.on('close', () => {
    if (player && room) {
      room.players.delete(ws);
      broadcast(room, { type: 'playerLeft', id: player.id });
      log(`➖ ${player.pseudo} quitte "${room.id}" — ${room.players.size} joueur(s)`);
      // Le salon "main" reste actif même sans joueurs (rotation continue)
      // Les autres salons sont supprimés s'ils sont vides depuis 30s
      if (room.id !== 'main' && room.players.size === 0) {
        setTimeout(() => {
          if (room.players.size === 0 && rooms.has(room.id)) {
            destroyRoom(room);
          }
        }, 30000);
      }
    }
  });

  ws.on('error', (err) => {
    log('WS error:', err.message);
  });
});

// Ping pour garder les connexions vivantes (anti-timeout sur certains hébergeurs)
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.players.keys()) {
      if (ws.readyState === ws.OPEN) {
        try { ws.ping(); } catch (e) {}
      }
    }
  }
}, 25000);

// === Démarrage ===
ensureMainRoom();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log(`🏍 Moto Race server actif sur :${PORT}`);
  log(`🗺  ${NUM_MAPS} maps · ${MAP_DURATION_MS / 60000} min par map · ${TRANSITION_MS / 1000}s de transition`);
});
