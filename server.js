const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar Firebase Admin usando Variables de Entorno (Compatible con Render)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  // Fallback local si usas el archivo json en tu máquina
  const fs = require('fs');
  const keyPath = path.join(__dirname, 'firebase-key.json');
  if (fs.existsSync(keyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    console.error("[ERROR] No se encontró la configuración de Firebase.");
  }
}

const db = admin.apps.length ? admin.firestore() : null;

const LOBBY_WAIT_TIME = 30000;
const MAX_PLAYERS_PER_MATCH = 50;
const STARTING_HP = 100;
const STARTING_MONEY = 5000;
const MAP_SECTORS = ['Playa', 'Pueblo Fantasma', 'Selva', 'Bunker', 'Zona de Extraccion'];

const WEAPONS = {
  pistolas: [
    { id: 'p250', name: 'P250', damage: 15, price: 500, fireRate: 400, accuracy: 0.85, icon: '🔫' },
    { id: 'deagle', name: 'Desert Eagle', damage: 35, price: 1200, fireRate: 600, accuracy: 0.75, icon: '🔫' },
    { id: 'glock', name: 'Glock-18', damage: 12, price: 300, fireRate: 300, accuracy: 0.9, icon: '🔫' }
  ],
  escopetas: [
    { id: 'm870', name: 'M870', damage: 80, price: 2000, fireRate: 1000, accuracy: 0.6, icon: '🔫' },
    { id: 'sawed', name: 'Sawed-Off', damage: 65, price: 1500, fireRate: 800, accuracy: 0.5, icon: '🔫' },
    { id: 'spas12', name: 'SPAS-12', damage: 75, price: 2500, fireRate: 900, accuracy: 0.65, icon: '🔫' }
  ],
  subfusiles: [
    { id: 'uzi', name: 'UZI', damage: 18, price: 1800, fireRate: 100, accuracy: 0.7, icon: '🔫' },
    { id: 'mp5', name: 'MP5', damage: 22, price: 2200, fireRate: 120, accuracy: 0.75, icon: '🔫' },
    { id: 'vector', name: 'Kriss Vector', damage: 20, price: 2800, fireRate: 80, accuracy: 0.72, icon: '🔫' }
  ],
  francotiradores: [
    { id: 'awm', name: 'AWM', damage: 100, price: 5000, fireRate: 2000, accuracy: 0.95, icon: '🎯' },
    { id: 'm24', name: 'M24', damage: 85, price: 3500, fireRate: 1800, accuracy: 0.9, icon: '🎯' },
    { id: 'dragunov', name: 'Dragunov', damage: 70, price: 2800, fireRate: 1500, accuracy: 0.88, icon: '🎯' }
  ]
};

const ARMORS = [
  { id: 'chaleco1', name: 'Chaleco Ligero', protection: 15, price: 800, icon: '🛡️' },
  { id: 'chaleco2', name: 'Chaleco Tactico', protection: 35, price: 1800, icon: '🛡️' },
  { id: 'chaleco3', name: 'Chaleco Pesado', protection: 55, price: 3200, icon: '🛡️' },
  { id: 'chaleco4', name: 'Chaleco Militar', protection: 75, price: 5000, icon: '🛡️' }
];

const MEDICINES = [
  { id: 'vendas', name: 'Vendas', heal: 15, price: 200, icon: '🩹' },
  { id: 'botiquin', name: 'Botiquin', heal: 40, price: 600, icon: '💊' },
  { id: 'medkit', name: 'MedKit Militar', heal: 75, price: 1200, icon: '🏥' },
  { id: 'adrenalina', name: 'Adrenalina', heal: 100, price: 2000, icon: '💉' }
];

const SKINS = [
  { id: 'skin_default', name: 'Soldado Basico', price: 0, rarity: 'comun', color: '#8B4513', icon: '👤' },
  { id: 'skin_ninja', name: 'Ninja Nocturno', price: 1500, rarity: 'raro', color: '#2C003E', icon: '🥷' },
  { id: 'skin_cyber', name: 'Cyber-Soldado', price: 3000, rarity: 'epico', color: '#00FFFF', icon: '🤖' },
  { id: 'skin_oro', name: 'Comandante de Oro', price: 8000, rarity: 'legendario', color: '#FFD700', icon: '👑' },
  { id: 'skin_zombie', name: 'Superviviente Zombie', price: 2500, rarity: 'epico', color: '#2E8B57', icon: '🧟' },
  { id: 'skin_samurai', name: 'Samurai Futurista', price: 5000, rarity: 'legendario', color: '#DC143C', icon: '⚔️' }
];

const LOOT_TABLE = [
  ...WEAPONS.pistolas.map(w => ({ ...w, type: 'weapon' })),
  ...WEAPONS.escopetas.map(w => ({ ...w, type: 'weapon' })),
  ...WEAPONS.subfusiles.map(w => ({ ...w, type: 'weapon' })),
  ...ARMORS.map(a => ({ ...a, type: 'armor' })),
  ...MEDICINES.map(m => ({ ...m, type: 'medicine' })),
  { id: 'llave_ext', name: 'Llave de Extraccion', type: 'key', price: 0, icon: '🔑' },
  { id: 'dinero', name: 'Dinero Sucio', type: 'money', amount: 500, price: 0, icon: '💵' }
];

const onlinePlayers = new Map();
const lobbies = new Map();
const activeMatches = new Map();

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function createMatch(lobbyId) {
  const matchId = generateId();
  const match = {
    id: matchId,
    lobbyId,
    players: new Map(),
    alivePlayers: new Set(),
    sectorStatus: {},
    extractionAvailable: false,
    started: false,
    ended: false,
    winner: null,
    killFeed: [],
    lootSpawns: []
  };

  MAP_SECTORS.forEach(sector => {
    match.sectorStatus[sector] = {
      dangerLevel: Math.random(),
      bombarded: false,
      lastBombardment: 0
    };
  });

  for (let i = 0; i < 30; i++) {
    match.lootSpawns.push({
      id: generateId(),
      sector: MAP_SECTORS[Math.floor(Math.random() * MAP_SECTORS.length)],
      item: LOOT_TABLE[Math.floor(Math.random() * LOOT_TABLE.length)],
      taken: false
    });
  }

  activeMatches.set(matchId, match);
  return match;
}

function getPlayerDamage(weaponId, armorProtection) {
  let weapon = null;
  Object.values(WEAPONS).forEach(cat => {
    const found = cat.find(w => w.id === weaponId);
    if (found) weapon = found;
  });
  if (!weapon) return Math.max(5, 10 - armorProtection);
  const baseDamage = weapon.damage;
  const accuracyRoll = Math.random();
  const hitMultiplier = accuracyRoll < weapon.accuracy ? 1 : (accuracyRoll < weapon.accuracy + 0.15 ? 0.5 : 0);
  const protectionReduction = armorProtection * 0.5;
  return Math.max(1, Math.floor(baseDamage * hitMultiplier - protectionReduction));
}

function getRandomSectorEvent() {
  const events = ['bombardeo', 'derrumbe', 'niebla_toxica', 'superviviente_hostil'];
  return events[Math.floor(Math.random() * events.length)];
}

async function getOrCreatePlayer(phone, name) {
  if (!db) {
    return {
      phone,
      name: name || `Soldado_${phone.slice(-4)}`,
      money: STARTING_MONEY,
      hp: STARTING_HP,
      maxHp: STARTING_HP,
      inventory: { weapons: ['glock'], armors: [], medicines: ['vendas'], keys: 0, equippedWeapon: 'glock', equippedArmor: null },
      skins: ['skin_default'],
      equippedSkin: 'skin_default'
    };
  }

  const docRef = db.collection('players').doc(phone);
  const doc = await docRef.get();

  if (doc.exists) {
    return { id: phone, ...doc.data() };
  }

  const newPlayer = {
    phone,
    name: name || `Soldado_${phone.slice(-4)}`,
    money: STARTING_MONEY,
    hp: STARTING_HP,
    maxHp: STARTING_HP,
    level: 1,
    xp: 0,
    kills: 0,
    deaths: 0,
    wins: 0,
    matches: 0,
    inventory: {
      weapons: ['glock'],
      armors: [],
      medicines: ['vendas'],
      keys: 0,
      equippedWeapon: 'glock',
      equippedArmor: null
    },
    skins: ['skin_default'],
    equippedSkin: 'skin_default',
    house: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastLogin: admin.firestore.FieldValue.serverTimestamp()
  };

  await docRef.set(newPlayer);
  return { id: phone, ...newPlayer };
}

async function updatePlayerProfile(phone, updates) {
  if (!db) return;
  const docRef = db.collection('players').doc(phone);
  await docRef.update({
    ...updates,
    lastLogin: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function addTransaction(phone, type, item, amount) {
  if (!db) return;
  await db.collection('transactions').add({
    phone,
    type,
    item,
    amount,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
}

io.on('connection', (socket) => {
  console.log(`[+] Jugador conectado: ${socket.id}`);

  socket.on('auth:register', async ({ phone, name }) => {
    try {
      const player = await getOrCreatePlayer(phone, name);
      onlinePlayers.set(socket.id, { socket, phone, player, inMatch: false, matchId: null });
      socket.emit('auth:success', { player, token: generateId() });
      io.emit('lobby:playerCount', onlinePlayers.size);
    } catch (err) {
      socket.emit('auth:error', err.message);
    }
  });

  socket.on('auth:login', async ({ phone }) => {
    try {
      if (!db) {
        const player = await getOrCreatePlayer(phone);
        onlinePlayers.set(socket.id, { socket, phone, player, inMatch: false, matchId: null });
        socket.emit('auth:success', { player, token: generateId() });
        return;
      }
      const doc = await db.collection('players').doc(phone).get();
      if (!doc.exists) {
        socket.emit('auth:error', 'Jugador no encontrado. Registrate primero.');
        return;
      }
      const player = { id: phone, ...doc.data() };
      onlinePlayers.set(socket.id, { socket, phone, player, inMatch: false, matchId: null });
      await updatePlayerProfile(phone, {});
      socket.emit('auth:success', { player, token: generateId() });
      io.emit('lobby:playerCount', onlinePlayers.size);
    } catch (err) {
      socket.emit('auth:error', err.message);
    }
  });

  socket.on('shop:getCatalog', () => {
    socket.emit('shop:catalog', { weapons: WEAPONS, armors: ARMORS, medicines: MEDICINES, skins: SKINS });
  });

  socket.on('lobby:join', async ({ phone }) => {
    const session = onlinePlayers.get(socket.id);
    if (!session) return;

    let lobby = null;
    for (const [id, l] of lobbies) {
      if (l.players.size < MAX_PLAYERS_PER_MATCH && !l.started) {
        lobby = l;
        break;
      }
    }

    if (!lobby) {
      const lobbyId = generateId();
      lobby = {
        id: lobbyId,
        players: new Map(),
        started: false,
        startTime: Date.now() + LOBBY_WAIT_TIME,
        timer: null
      };
      lobbies.set(lobbyId, lobby);

      lobby.timer = setTimeout(() => {
        if (lobby.players.size >= 2) {
          startMatch(lobby);
        } else {
          lobby.players.forEach((p, sid) => {
            p.socket.emit('lobby:cancelled', 'No hay suficientes jugadores');
          });
          lobbies.delete(lobbyId);
        }
      }, LOBBY_WAIT_TIME);
    }

    let playerData = session.player;
    if (db) {
      const doc = await db.collection('players').doc(phone).get();
      if (doc.exists) playerData = doc.data();
    }

    lobby.players.set(socket.id, {
      socket,
      phone,
      name: playerData.name || 'Soldado',
      hp: STARTING_HP,
      maxHp: playerData.maxHp || STARTING_HP,
      sector: 'Playa',
      skin: playerData.equippedSkin || 'skin_default',
      weapon: playerData.inventory?.equippedWeapon || 'glock',
      armor: playerData.inventory?.equippedArmor || null,
      inventory: playerData.inventory || {},
      alive: true,
      kills: 0
    });

    session.lobbyId = lobby.id;
    socket.join(lobby.id);
    socket.emit('lobby:joined', {
      lobbyId: lobby.id,
      players: Array.from(lobby.players.values()).map(p => ({ name: p.name, skin: p.skin })),
      countdown: Math.max(0, lobby.startTime - Date.now())
    });

    lobby.players.forEach((p, sid) => {
      if (sid !== socket.id) {
        p.socket.emit('lobby:playerJoined', { name: playerData.name, skin: playerData.equippedSkin });
      }
    });

    if (lobby.players.size >= MAX_PLAYERS_PER_MATCH) {
      clearTimeout(lobby.timer);
      startMatch(lobby);
    }
  });

  socket.on('lobby:leave', () => {
    const session = onlinePlayers.get(socket.id);
    if (session && session.lobbyId) {
      const lobby = lobbies.get(session.lobbyId);
      if (lobby) {
        lobby.players.delete(socket.id);
        socket.leave(session.lobbyId);
        if (lobby.players.size === 0) {
          clearTimeout(lobby.timer);
          lobbies.delete(session.lobbyId);
        }
      }
      session.lobbyId = null;
    }
  });

  function startMatch(lobby) {
    lobby.started = true;
    const match = createMatch(lobby.id);

    lobby.players.forEach((player, sid) => {
      match.players.set(sid, {
        ...player,
        x: Math.random() * 800,
        y: Math.random() * 600,
        hp: player.maxHp,
        alive: true
      });
      match.alivePlayers.add(sid);

      const session = onlinePlayers.get(sid);
      if (session) {
        session.inMatch = true;
        session.matchId = match.id;
      }

      player.socket.join(match.id);
      player.socket.emit('match:start', {
        matchId: match.id,
        sector: player.sector,
        hp: player.maxHp,
        maxHp: player.maxHp,
        players: Array.from(match.players.values()).map(p => ({
          id: p.socket.id,
          name: p.name,
          x: p.x,
          y: p.y,
          skin: p.skin,
          hp: p.hp,
          maxHp: p.maxHp,
          alive: p.alive
        }))
      });
    });

    lobbies.delete(lobby.id);

    setTimeout(() => {
      match.extractionAvailable = true;
      io.to(match.id).emit('match:extractionAvailable', {
        sector: 'Zona de Extraccion',
        message: 'El helicoptero de extraccion ha llegado a la Zona de Extraccion!'
      });
    }, 120000);

    const gameLoop = setInterval(() => {
      if (match.ended) {
        clearInterval(gameLoop);
        return;
      }

      MAP_SECTORS.forEach(sector => {
        const status = match.sectorStatus[sector];
        if (Math.random() < 0.02 && !status.bombarded) {
          status.bombarded = true;
          status.lastBombardment = Date.now();
          io.to(match.id).emit('match:sectorEvent', {
            sector,
            event: getRandomSectorEvent(),
            message: `Evento en ${sector}!`
          });

          setTimeout(() => { status.bombarded = false; }, 30000);
        }
      });

      if (match.alivePlayers.size <= 1 && match.started) {
        match.ended = true;
        const winner = match.alivePlayers.values().next().value;
        if (winner) {
          const winnerPlayer = match.players.get(winner);
          match.winner = winnerPlayer;
          endMatch(match, winnerPlayer);
        }
        clearInterval(gameLoop);
      }
    }, 5000);
  }

  async function endMatch(match, winner) {
    if (winner && db) {
      await db.collection('players').doc(winner.phone).update({
        wins: admin.firestore.FieldValue.increment(1),
        matches: admin.firestore.FieldValue.increment(1),
        money: admin.firestore.FieldValue.increment(3000),
        kills: admin.firestore.FieldValue.increment(winner.kills || 0)
      });
    }

    if (winner) {
      io.to(match.id).emit('match:end', {
        winner: winner.name,
        message: `${winner.name} ha ganado la partida!`,
        reward: 3000
      });
    }

    match.players.forEach((player, sid) => {
      const session = onlinePlayers.get(sid);
      if (session) {
        session.inMatch = false;
        session.matchId = null;
      }
      player.socket.leave(match.id);
    });

    setTimeout(() => activeMatches.delete(match.id), 30000);
  }

  socket.on('game:move', ({ matchId, sector }) => {
    const match = activeMatches.get(matchId);
    if (!match || match.ended) return;

    const player = match.players.get(socket.id);
    if (!player || !player.alive) return;

    player.sector = sector;
    socket.emit('game:moved', { sector, hp: player.hp, maxHp: player.maxHp });
    socket.to(matchId).emit('game:playerMoved', {
      id: socket.id,
      name: player.name,
      sector,
      skin: player.skin,
      hp: player.hp,
      maxHp: player.maxHp
    });
  });

  socket.on('game:shoot', ({ matchId, targetId }) => {
    const match = activeMatches.get(matchId);
    if (!match || match.ended) return;

    const attacker = match.players.get(socket.id);
    const target = match.players.get(targetId);
    if (!attacker || !target || !attacker.alive || !target.alive) return;
    if (attacker.sector !== target.sector) return;

    let armorProtection = 0;
    const damage = getPlayerDamage(attacker.weapon, armorProtection);
    target.hp = Math.max(0, target.hp - damage);

    io.to(matchId).emit('game:shotFired', {
      attacker: socket.id,
      attackerName: attacker.name,
      target: targetId,
      targetName: target.name,
      damage,
      sector: attacker.sector,
      weapon: attacker.weapon
    });

    if (target.hp <= 0) {
      target.alive = false;
      match.alivePlayers.delete(targetId);
      attacker.kills = (attacker.kills || 0) + 1;
    }
  });

  socket.on('disconnect', () => {
    const session = onlinePlayers.get(socket.id);
    if (session) {
      if (session.matchId) {
        const match = activeMatches.get(session.matchId);
        if (match) {
          const player = match.players.get(socket.id);
          if (player && player.alive) {
            player.alive = false;
            match.alivePlayers.delete(socket.id);
          }
        }
      }
      onlinePlayers.delete(socket.id);
      io.emit('lobby:playerCount', onlinePlayers.size);
    }
    console.log(`[-] Jugador desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVIDOR] Battle Royale Tactico corriendo en puerto ${PORT}`);
  if (db) console.log(`[FIREBASE] Conectado correctamente.`);
  else console.log(`[FIREBASE] Modo sin base de datos (Ejecutándose en memoria).`);
});
