const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffleNumbers(max = 130) {
  const nums = Array.from({ length: max }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

function publicRoom(room) {
  return {
    code: room.code,
    board: room.board,
    players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, score: p.score })),
    currentCallerId: room.currentCallerId,
    target: room.target,
    found: Array.from(room.found),
    round: room.round,
    gameStarted: room.gameStarted,
    winner: room.winner || null
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    let code;
    do code = roomCode(); while (rooms.has(code));

    const room = {
      code,
      board: shuffleNumbers(130),
      players: [{ id: socket.id, name: name || 'Player 1', role: 'player', score: 0 }],
      currentCallerId: socket.id,
      target: null,
      found: new Set(),
      round: 1,
      gameStarted: false,
      winner: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ code, name }, cb) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (room.players.length >= 2) return cb?.({ ok: false, error: 'This room already has two players.' });

    room.players.push({ id: socket.id, name: name || 'Player 2', role: 'player', score: 0 });
    room.gameStarted = true;
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(room);
  });

  socket.on('game:call', ({ number }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameStarted) return;
    if (socket.id !== room.currentCallerId) return cb?.({ ok: false, error: 'It is not your turn to call a number.' });
    if (room.target !== null) return cb?.({ ok: false, error: 'The current number has not been found yet.' });

    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || n > 130) return cb?.({ ok: false, error: 'Choose a number from 1 to 130.' });
    if (room.found.has(n)) return cb?.({ ok: false, error: 'That number has already been found.' });

    room.target = n;
    broadcastRoom(room);
    cb?.({ ok: true });
  });

  socket.on('game:find', ({ number }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameStarted) return;
    if (socket.id === room.currentCallerId) return cb?.({ ok: false, error: 'The other player is searching this round.' });
    if (room.target === null) return cb?.({ ok: false, error: 'Wait for a number to be called.' });

    const n = Number(number);
    if (n !== room.target) {
      socket.emit('game:miss', { number: n });
      return cb?.({ ok: false, error: 'Not the called number.' });
    }

    room.found.add(n);
    const finder = room.players.find(p => p.id === socket.id);
    if (finder) finder.score += 1;
    room.target = null;
    room.round += 1;

    if (room.found.size >= 130) {
      const sorted = [...room.players].sort((a,b) => b.score - a.score);
      room.winner = sorted[0]?.name || 'Winner';
    } else {
      room.currentCallerId = socket.id; // finder becomes the next caller
    }

    broadcastRoom(room);
    io.to(room.code).emit('game:found', { number: n, finderId: socket.id });
    cb?.({ ok: true });
  });

  socket.on('game:new', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.board = shuffleNumbers(130);
    room.found = new Set();
    room.target = null;
    room.round = 1;
    room.winner = null;
    room.players.forEach(p => p.score = 0);
    room.currentCallerId = room.players[0]?.id || null;
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }
    room.gameStarted = false;
    room.target = null;
    room.currentCallerId = room.players[0].id;
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Number Hunt running on http://localhost:${PORT}`));
