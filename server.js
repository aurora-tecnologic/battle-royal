const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let jugadores = {};

io.on('connection', (socket) => {
  console.log(`🔌 Conectado: ${socket.id}`);

  socket.on('player:join', (data) => {
    jugadores[socket.id] = {
      id: socket.id,
      telefono: data.telefono || 'Desconocido',
      dinero: 2000,
      vida: 100,
      sector: 'Playa de Aterrizaje'
    };
    io.emit('state:update', jugadores);
  });

  socket.on('player:action', (accion) => {
    let p = jugadores[socket.id];
    if (!p) return;
    if (accion.tipo === 'mover') p.sector = accion.sector;
    io.emit('state:update', jugadores);
  });

  socket.on('disconnect', () => {
    delete jugadores[socket.id];
    io.emit('state:update', jugadores);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
