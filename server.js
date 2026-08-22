const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar Firebase
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  const fs = require('fs');
  const keyPath = path.join(__dirname, 'firebase-key.json');
  if (fs.existsSync(keyPath)) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, 'utf8'))) });
  }
}
const db = admin.apps.length ? admin.firestore() : null;

const STARTING_MONEY = 5000;
const WEAPONS = {
  pistolas: [
    { id: 'p250', name: 'P250 Tactical', damage: 15, price: 500, icon: '🔫' },
    { id: 'deagle', name: '.50 Desert Eagle', damage: 35, price: 1200, icon: '💥' },
    { id: 'glock', name: 'Glock-18C', damage: 12, price: 300, icon: '🔫' }
  ],
  subfusiles: [
    { id: 'uzi', name: 'UZI Sub-Machine', damage: 18, price: 1800, icon: '⚡' },
    { id: 'mp5', name: 'MP5 Navy', damage: 22, price: 2200, icon: '🔥' }
  ],
  francotiradores: [
    { id: 'awm', name: 'AWM Sniper', damage: 100, price: 5000, icon: '🎯' }
  ]
};

const onlinePlayers = new Map();   // socket.id -> { socket, phone, player }
const waitingLobby = [];
const activeMatches = new Map();   // matchId -> { players: Map(socket.id -> gameState) }
let matchCounter = 1;

const MAP_SIZE = 1000;
const HIT_RANGE = 40; // distancia máxima para que un disparo conecte (ajustaremos con hitbox real después)

function getWeaponById(itemId) {
  let weapon = null;
  Object.values(WEAPONS).forEach(cat => {
    const found = cat.find(w => w.id === itemId);
    if (found) weapon = found;
  });
  return weapon;
}

function randomSpawn() {
  return {
    x: Math.floor(Math.random() * MAP_SIZE),
    y: Math.floor(Math.random() * MAP_SIZE)
  };
}

io.on('connection', (socket) => {
  console.log(`[+] Conectado: ${socket.id}`);

  socket.on('auth:register', async ({ phone, name }) => {
    let player = { phone, name, money: STARTING_MONEY, inventory: { weapons: ['glock'] } };
    if (db) {
      const docRef = db.collection('players').doc(phone);
      const doc = await docRef.get();
      if (!doc.exists) await docRef.set(player);
      else player = doc.data();
    }
    onlinePlayers.set(socket.id, { socket, phone, player });
    socket.emit('auth:success', { player });
  });

  socket.on('auth:login', async ({ phone }) => {
    let player = { phone, name: 'Soldado', money: STARTING_MONEY, inventory: { weapons: ['glock'] } };
    if (db) {
      const docRef = db.collection('players').doc(phone);
      const doc = await docRef.get();
      if (!doc.exists) return socket.emit('auth:error', 'Usuario no registrado.');
      player = doc.data();
    }
    onlinePlayers.set(socket.id, { socket, phone, player });
    socket.emit('auth:success', { player });
  });

  socket.on('shop:getCatalog', () => {
    socket.emit('shop:catalog', { weapons: WEAPONS });
  });

  socket.on('shop:buy', async ({ phone, itemId }) => {
    const weapon = getWeaponById(itemId);
    if (!weapon) return socket.emit('shop:error', 'Arma no encontrada.');
    const session = onlinePlayers.get(socket.id);
    if (!session) return;

    if (session.player.money < weapon.price) {
      return socket.emit('shop:error', 'Fondos insuficientes.');
    }

    session.player.money -= weapon.price;
    if (!session.player.inventory.weapons.includes(itemId)) {
      session.player.inventory.weapons.push(itemId);
    }

    if (db) {
      await db.collection('players').doc(phone).update({
        money: session.player.money,
        'inventory.weapons': session.player.inventory.weapons
      });
    }

    socket.emit('shop:success', { item: weapon, money: session.player.money, player: session.player });
  });

  socket.on('lobby:join', ({ phone }) => {
    const session = onlinePlayers.get(socket.id);
    if (!session) return;

    if (!waitingLobby.includes(socket.id)) {
      waitingLobby.push(socket.id);
    }

    io.emit('lobby:status', { count: waitingLobby.length });

    if (waitingLobby.length >= 1) {
      setTimeout(() => startMatch(), 3000);
    }
  });

  // ---------- INICIO DE PARTIDA ----------
  function startMatch() {
    if (waitingLobby.length === 0) return;
    const matchId = `MATCH_${matchCounter++}`;
    const matchPlayers = new Map();

    waitingLobby.forEach((sockId) => {
      const session = onlinePlayers.get(sockId);
      if (!session) return;
      const spawn = randomSpawn();
      matchPlayers.set(sockId, {
        phone: session.phone,
        name: session.player.name,
        x: spawn.x,
        y: spawn.y,
        rotation: 0,
        hp: 100,
        shield: 0,
        weapon: 'glock',
        alive: true
      });
      session.socket.join(matchId);
      session.matchId = matchId;
    });

    activeMatches.set(matchId, { players: matchPlayers });
    waitingLobby.length = 0;

    // Enviar a cada jugador el estado inicial de todos
    io.to(matchId).emit('match:started', {
      matchId,
      players: Array.from(matchPlayers.entries()).map(([id, p]) => ({ id, ...p }))
    });
  }

  // ---------- MOVIMIENTO ----------
  socket.on('player:move', ({ x, y, rotation }) => {
    const session = onlinePlayers.get(socket.id);
    if (!session || !session.matchId) return;

    const match = activeMatches.get(session.matchId);
    if (!match) return;

    const gp = match.players.get(socket.id);
    if (!gp || !gp.alive) return;

    // Clamp para que no salgan del mapa
    gp.x = Math.max(0, Math.min(MAP_SIZE, x));
    gp.y = Math.max(0, Math.min(MAP_SIZE, y));
    gp.rotation = rotation || 0;

    // Retransmitir a los demás jugadores de la partida (no a sí mismo)
    socket.to(session.matchId).emit('player:moved', {
      id: socket.id,
      x: gp.x,
      y: gp.y,
      rotation: gp.rotation
    });
  });

  // ---------- DISPARO / COMBATE ----------
  socket.on('player:shoot', ({ targetId }) => {
    const session = onlinePlayers.get(socket.id);
    if (!session || !session.matchId) return;

    const match = activeMatches.get(session.matchId);
    if (!match) return;

    const shooter = match.players.get(socket.id);
    const target = match.players.get(targetId);
    if (!shooter || !target || !shooter.alive || !target.alive) return;

    // Validar distancia real en servidor (nunca confiar en el cliente)
    const dist = Math.hypot(shooter.x - target.x, shooter.y - target.y);
    if (dist > HIT_RANGE) {
      return; // disparo fuera de rango, se ignora silenciosamente
    }

    const weapon = getWeaponById(shooter.weapon) || { damage: 10 };
    let damage = weapon.damage;

    // El escudo absorbe primero
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, damage);
      target.shield -= absorbed;
      damage -= absorbed;
    }
    target.hp = Math.max(0, target.hp - damage);

    io.to(session.matchId).emit('player:hit', {
      shooterId: socket.id,
      targetId,
      damage: weapon.damage,
      targetHp: target.hp,
      targetShield: target.shield
    });

    if (target.hp <= 0) {
      target.alive = false;
      io.to(session.matchId).emit('player:eliminated', {
        targetId,
        killerId: socket.id
      });
      checkMatchEnd(session.matchId);
    }
  });

  function checkMatchEnd(matchId) {
    const match = activeMatches.get(matchId);
    if (!match) return;
    const alivePlayers = Array.from(match.players.entries()).filter(([, p]) => p.alive);
    if (alivePlayers.length <= 1) {
      const winner = alivePlayers[0];
      io.to(matchId).emit('match:ended', {
        winnerId: winner ? winner[0] : null,
        winnerName: winner ? winner[1].name : null
      });
      activeMatches.delete(matchId);
    }
  }

  socket.on('disconnect', () => {
    const session = onlinePlayers.get(socket.id);
    if (session && session.matchId) {
      const match = activeMatches.get(session.matchId);
      if (match && match.players.has(socket.id)) {
        match.players.get(socket.id).alive = false;
        io.to(session.matchId).emit('player:eliminated', {
          targetId: socket.id,
          killerId: null
        });
        checkMatchEnd(session.matchId);
      }
    }
    onlinePlayers.delete(socket.id);
    const index = waitingLobby.indexOf(socket.id);
    if (index > -1) waitingLobby.splice(index, 1);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
