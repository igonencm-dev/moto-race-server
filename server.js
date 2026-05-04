// =====================================================
// MOTO RACE - serveur de salons persistants
// Node.js + WebSocket. Rotation auto des maps toutes les 5 min.
// =====================================================

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// === Config ===
const NUM_MAPS = 28;
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
      kind: 'public',                  // 'public' (rotation auto) ou 'private' (BO sur invitation)
      currentMapIdx: 0,
      mapStartedAt: Date.now(),
      inTransition: false,
      transitionEndsAt: null,
      nextMapIdx: null,
      nextMapChosenBy: null,
      players: new Map(),
      tickInterval: null,
      // Champs propres aux salons privés (vides pour les publics)
      hostId: null,
      mapSequence: null,               // [idx, idx, ...] config BO
      durationPerMap: null,            // secondes par map
      lobbyState: 'waiting',           // 'waiting' / 'racing' / 'transition' / 'finished'
      currentSeqIdx: 0,                // index dans mapSequence
      bestPerMap: [],                  // [{ playerId, pseudo, time, replay }]
      replaysSent: new Map()           // playerId → replay (pour la map en cours)
    };
    rooms.set(roomId, room);
    startRoomLoop(room);
    log(`📦 Nouveau salon "${roomId}"`);
  }
  return rooms.get(roomId);
}

// Génère un code de salon court et lisible (ex: "K3NP")
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/I/1
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has('priv-' + code));
  return code;
}

// Crée un salon privé (BO custom configuré par le host)
function createPrivateRoom(hostWs, hostPlayer, config) {
  const code = generateRoomCode();
  const roomId = 'priv-' + code;
  const room = {
    id: roomId,
    kind: 'private',
    currentMapIdx: 0,
    mapStartedAt: 0,
    inTransition: false,
    transitionEndsAt: null,
    nextMapIdx: null,
    nextMapChosenBy: null,
    players: new Map(),
    tickInterval: null,
    hostId: hostPlayer.id,
    mapSequence: config.mapSequence,
    durationPerMap: config.durationPerMap,
    lobbyState: 'waiting',
    currentSeqIdx: 0,
    bestPerMap: [],
    replaysSent: new Map()
  };
  rooms.set(roomId, room);
  startRoomLoop(room);
  log(`🔒 Salon privé "${code}" créé par ${hostPlayer.pseudo} (host=${hostPlayer.id})`);
  return { code, roomId };
}

function pickRandomMap(currentIdx) {
  if (NUM_MAPS <= 1) return 0;
  let next;
  do {
    next = Math.floor(Math.random() * NUM_MAPS);
  } while (next === currentIdx);
  return next;
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
  // Utilise la map choisie/random pendant la transition
  room.currentMapIdx = (room.nextMapIdx !== null && room.nextMapIdx !== undefined)
    ? room.nextMapIdx
    : pickRandomMap(room.currentMapIdx);
  room.mapStartedAt = Date.now();
  room.inTransition = false;
  room.transitionEndsAt = null;
  room.nextMapIdx = null;
  room.nextMapChosenBy = null;
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
  // Map suivante par défaut = random (les joueurs peuvent override avec chooseNextMap)
  room.nextMapIdx = pickRandomMap(room.currentMapIdx);
  room.nextMapChosenBy = null;

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
    nextMapIdx: room.nextMapIdx,
    nextMapChosenBy: null
  });
  log(`🏁 Salon "${room.id}" : fin map ${room.currentMapIdx}, ${scores.length} score(s)`);
}

function startRoomLoop(room) {
  room.tickInterval = setInterval(() => {
    const now = Date.now();
    if (room.kind === 'private') {
      // Salons privés : pilotés par le host, pas de rotation auto
      if (room.lobbyState === 'racing') {
        const elapsed = now - room.mapStartedAt;
        const durationMs = room.durationPerMap * 1000;
        if (elapsed >= durationMs) {
          endPrivateMap(room);
        }
      } else if (room.lobbyState === 'transition') {
        if (now >= room.transitionEndsAt) {
          startNextPrivateMap(room);
        }
      }
    } else {
      // Salons publics : rotation auto comme avant
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
    }
  }, 500);
}

// === Salons privés : démarrage du BO par le host ===
function startPrivateBO(room) {
  room.lobbyState = 'racing';
  room.currentSeqIdx = 0;
  room.bestPerMap = [];
  room.replaysSent.clear();
  room.currentMapIdx = room.mapSequence[0];
  room.mapStartedAt = Date.now();
  // Reset des bests perso
  for (const p of room.players.values()) {
    p.sessionBest = null;
    p.runCount = 0;
  }
  broadcast(room, {
    type: 'privateBOStart',
    mapSequence: room.mapSequence,
    durationPerMap: room.durationPerMap,
    currentSeqIdx: 0,
    currentMapIdx: room.currentMapIdx,
    mapStartedAt: room.mapStartedAt,
    mapDuration: room.durationPerMap * 1000
  });
  log(`🟢 BO privé "${room.id}" démarré : ${room.mapSequence.length} maps × ${room.durationPerMap}s`);
}

// Fin de la map en cours dans un salon privé : top scores, attente des replays
function endPrivateMap(room) {
  room.lobbyState = 'transition';
  // Tous les joueurs ont jusqu'à TRANSITION_MS pour envoyer leur replay
  room.transitionEndsAt = Date.now() + TRANSITION_MS;

  // Top scores de la map (uniquement ceux qui ont fini)
  const scores = Array.from(room.players.values())
    .filter(p => p.sessionBest !== null && p.sessionBest !== undefined)
    .map(p => ({ id: p.id, pseudo: p.pseudo, time: p.sessionBest }))
    .sort((a, b) => a.time - b.time);

  // Garde le best (vainqueur) de cette map pour récap final
  const winner = scores[0] || null;
  room.bestPerMap.push({
    seqIdx: room.currentSeqIdx,
    mapIdx: room.currentMapIdx,
    scores,
    winnerId: winner ? winner.id : null,
    winnerReplay: null  // sera rempli quand le vainqueur enverra son replay
  });

  broadcast(room, {
    type: 'privateMapEnd',
    seqIdx: room.currentSeqIdx,
    mapIdx: room.currentMapIdx,
    scores,
    nextAt: room.transitionEndsAt,
    isLastMap: room.currentSeqIdx >= room.mapSequence.length - 1
  });
  log(`🏁 Salon privé "${room.id}" : map ${room.currentSeqIdx + 1}/${room.mapSequence.length} terminée (${scores.length} scores)`);
}

function startNextPrivateMap(room) {
  // Si BO terminé, on revient au lobby (les joueurs peuvent relancer un nouveau BO sans quitter)
  if (room.currentSeqIdx >= room.mapSequence.length - 1) {
    room.lobbyState = 'waiting';
    room.currentSeqIdx = 0;
    room.replaysSent.clear();
    // Reset bests perso pour le prochain BO
    for (const p of room.players.values()) {
      p.sessionBest = null;
      p.runCount = 0;
    }
    const bestPerMapPayload = room.bestPerMap.map(b => ({
      seqIdx: b.seqIdx,
      mapIdx: b.mapIdx,
      scores: b.scores,
      winnerId: b.winnerId,
      winnerReplay: b.winnerReplay
    }));
    const playerList = Array.from(room.players.values()).map(p => ({
      id: p.id, pseudo: p.pseudo, isHost: p.id === room.hostId
    }));
    broadcast(room, {
      type: 'privateBOEnd',
      bestPerMap: bestPerMapPayload,
      // Données du lobby pour permettre le retour
      roomCode: room.id.replace(/^priv-/, ''),
      hostId: room.hostId,
      mapSequence: room.mapSequence,
      durationPerMap: room.durationPerMap,
      players: playerList
    });
    log(`🏆 Salon privé "${room.id}" : BO terminé, retour lobby`);
    return;
  }
  room.currentSeqIdx++;
  room.currentMapIdx = room.mapSequence[room.currentSeqIdx];
  room.mapStartedAt = Date.now();
  room.lobbyState = 'racing';
  room.replaysSent.clear();
  // Reset bests des joueurs pour la nouvelle map
  for (const p of room.players.values()) {
    p.sessionBest = null;
    p.runCount = 0;
  }
  broadcast(room, {
    type: 'privateMapStart',
    seqIdx: room.currentSeqIdx,
    currentMapIdx: room.currentMapIdx,
    mapStartedAt: room.mapStartedAt,
    mapDuration: room.durationPerMap * 1000
  });
  log(`🗺  Salon privé "${room.id}" : map ${room.currentSeqIdx + 1}/${room.mapSequence.length} (idx=${room.currentMapIdx})`);
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
        nextMapIdx: room.nextMapIdx,
        nextMapChosenBy: room.nextMapChosenBy,
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

    // === Création d'un salon privé (host crée + rejoint) ===
    if (msg.type === 'createRoom') {
      const pseudo = (msg.pseudo || 'anonyme').slice(0, 14);
      const mapSeq = Array.isArray(msg.mapSequence) ? msg.mapSequence.slice(0, 5) : null;
      const dur = parseInt(msg.durationPerMap);
      if (!mapSeq || !mapSeq.length || isNaN(dur) || dur < 30 || dur > 600) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'config_invalide' })); } catch (e) {}
        return;
      }
      // Crée le joueur
      player = {
        id: nextPlayerId(),
        pseudo,
        x: 0, y: 0, a: 0, wba: 0, wfa: 0,
        sessionBest: null, runCount: 0,
        finished: false, crashed: false
      };
      const { code, roomId } = createPrivateRoom(ws, player, {
        mapSequence: mapSeq,
        durationPerMap: dur
      });
      room = rooms.get(roomId);
      room.players.set(ws, player);
      ws.send(JSON.stringify({
        type: 'roomCreated',
        code,
        roomId,
        myId: player.id,
        isHost: true,
        mapSequence: room.mapSequence,
        durationPerMap: room.durationPerMap,
        players: [{ id: player.id, pseudo: player.pseudo, isHost: true }]
      }));
      log(`🟦 ${player.pseudo} (host) crée le salon ${code}`);
      return;
    }

    // === Rejoint un salon privé existant via code ===
    if (msg.type === 'joinRoom') {
      const code = (msg.code || '').toUpperCase().trim();
      const roomId = 'priv-' + code;
      if (!rooms.has(roomId)) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'salon_introuvable' })); } catch (e) {}
        return;
      }
      const targetRoom = rooms.get(roomId);
      if (targetRoom.lobbyState !== 'waiting') {
        try { ws.send(JSON.stringify({ type: 'error', error: 'partie_en_cours' })); } catch (e) {}
        return;
      }
      if (targetRoom.players.size >= 8) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'salon_plein' })); } catch (e) {}
        return;
      }
      player = {
        id: nextPlayerId(),
        pseudo: (msg.pseudo || 'anonyme').slice(0, 14),
        x: 0, y: 0, a: 0, wba: 0, wfa: 0,
        sessionBest: null, runCount: 0,
        finished: false, crashed: false
      };
      room = targetRoom;
      room.players.set(ws, player);
      // Envoie l'état du lobby au nouveau joueur
      ws.send(JSON.stringify({
        type: 'roomJoined',
        code,
        roomId,
        myId: player.id,
        isHost: false,
        hostId: room.hostId,
        mapSequence: room.mapSequence,
        durationPerMap: room.durationPerMap,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id, pseudo: p.pseudo, isHost: p.id === room.hostId
        }))
      }));
      // Notifie les autres
      broadcast(room, {
        type: 'lobbyPlayerJoined',
        id: player.id,
        pseudo: player.pseudo,
        isHost: false
      }, ws);
      log(`🔵 ${player.pseudo} rejoint salon ${code} — ${room.players.size} joueur(s)`);
      return;
    }

    // === Le host démarre le BO ===
    if (msg.type === 'startBO') {
      if (!room || room.kind !== 'private' || !player || player.id !== room.hostId) return;
      if (room.lobbyState !== 'waiting') return;
      startPrivateBO(room);
      return;
    }

    // === Le host change la config du salon (entre 2 BOs ou avant le 1er) ===
    if (msg.type === 'updateConfig') {
      if (!room || room.kind !== 'private' || !player || player.id !== room.hostId) return;
      if (room.lobbyState !== 'waiting') return;
      const mapSeq = Array.isArray(msg.mapSequence) ? msg.mapSequence.slice(0, 5) : null;
      const dur = parseInt(msg.durationPerMap);
      if (!mapSeq || !mapSeq.length || isNaN(dur) || dur < 30 || dur > 600) {
        try { ws.send(JSON.stringify({ type: 'error', error: 'config_invalide' })); } catch (e) {}
        return;
      }
      room.mapSequence = mapSeq;
      room.durationPerMap = dur;
      broadcast(room, {
        type: 'configUpdated',
        mapSequence: room.mapSequence,
        durationPerMap: room.durationPerMap
      });
      log(`⚙  Salon "${room.id}" : config mise à jour par ${player.pseudo}`);
      return;
    }

    // === Envoi du replay du joueur (à la fin de chaque map) ===
    if (msg.type === 'replayShare') {
      if (!room || room.kind !== 'private' || !player) return;
      if (!msg.replay || !msg.replay.frames) return;
      // Le serveur garde le replay du vainqueur de la map
      const lastBest = room.bestPerMap[room.bestPerMap.length - 1];
      if (lastBest && lastBest.winnerId === player.id) {
        lastBest.winnerReplay = msg.replay;
      }
      // Diffuse le replay à tous (chacun peut voir sa propre map favorite)
      broadcast(room, {
        type: 'replayBroadcast',
        playerId: player.id,
        pseudo: player.pseudo,
        replay: msg.replay
      }, ws);
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
    } else if (msg.type === 'chooseNextMap') {
      // Vote pour la prochaine map (uniquement pendant la transition)
      if (!room.inTransition) return;
      let chosenIdx;
      if (msg.mapIdx === 'random') {
        chosenIdx = pickRandomMap(room.currentMapIdx);
      } else {
        const idx = parseInt(msg.mapIdx);
        if (isNaN(idx) || idx < 0 || idx >= NUM_MAPS) return;
        chosenIdx = idx;
      }
      room.nextMapIdx = chosenIdx;
      room.nextMapChosenBy = player.pseudo;
      broadcast(room, {
        type: 'nextMapChosen',
        nextMapIdx: chosenIdx,
        nextMapChosenBy: player.pseudo,
        wasRandom: msg.mapIdx === 'random'
      });
      log(`🗳  ${player.pseudo} a choisi map ${chosenIdx}` + (msg.mapIdx === 'random' ? ' (random)' : ''));
    }
  });

  ws.on('close', () => {
    if (player && room) {
      room.players.delete(ws);
      broadcast(room, { type: 'playerLeft', id: player.id });
      log(`➖ ${player.pseudo} quitte "${room.id}" — ${room.players.size} joueur(s)`);

      // Salon privé : si le host quitte avant le démarrage, on transfère ou détruit
      if (room.kind === 'private' && player.id === room.hostId) {
        if (room.lobbyState === 'waiting' && room.players.size > 0) {
          // Transfère le host au plus ancien joueur restant
          const newHost = room.players.values().next().value;
          if (newHost) {
            room.hostId = newHost.id;
            broadcast(room, { type: 'hostChanged', newHostId: newHost.id, newHostPseudo: newHost.pseudo });
            log(`👑 Salon "${room.id}" : host transféré à ${newHost.pseudo}`);
          }
        }
      }

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
