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

const onlinePlayers = new Map();
const waitingLobby = [];
let matchCounter = 1;

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

  socket.on('shop:buy', async ({ phone, itemId, category }) => {
    let weapon = null;
    Object.values(WEAPONS).forEach(cat => {
      const found = cat.find(w => w.id === itemId);
      if (found) weapon = found;
    });

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
      setTimeout(() => {
        io.emit('match:started', { matchId: `MATCH_${matchCounter++}` });
        waitingLobby.length = 0;
      }, 3000);
    }
  });

  socket.on('disconnect', () => {
    onlinePlayers.delete(socket.id);
    const index = waitingLobby.indexOf(socket.id);
    if (index > -1) waitingLobby.splice(index, 1);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
