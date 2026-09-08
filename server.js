const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = new Map();
const ALLOWED_DIFFICULTIES = new Set([50, 100, 150]);
const ROUND_LIMIT_MS = 20000;

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffledBoard(maxNumber) {
  const nums = Array.from({ length: maxNumber }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

function publicRoom(room) {
  const now = Date.now();
  const elapsedMs = room.target && room.roundStartedAt ? Math.min(now - room.roundStartedAt, ROUND_LIMIT_MS) : 0;
  return {
    code: room.code,
    difficulty: room.difficulty,
    board: room.board,
    found: room.found,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      finds: p.finds,
      totalFindMs: p.totalFindMs,
      wrongTaps: p.wrongTaps
    })),
    currentCallerId: room.currentCallerId,
    target: room.target,
    round: room.round,
    gameStarted: room.players.length === 2,
    roundStartedAt: room.roundStartedAt,
    roundLimitMs: ROUND_LIMIT_MS,
    elapsedMs,
    lastResult: room.lastResult || null
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}

function getRoomForSocket(socket) {
  return rooms.get(socket.data.roomCode);
}

function sanitizeName(name) {
  const cleaned = String(name || 'Player').trim().replace(/[<>]/g, '').slice(0, 18);
  return cleaned || 'Player';
}

function endTimedOutRound(room) {
  if (!room.target || !room.roundStartedAt) return false;
  if (Date.now() - room.roundStartedAt < ROUND_LIMIT_MS) return false;

  const finder = room.players.find(p => p.id !== room.currentCallerId);
  if (finder) finder.score = Math.max(0, finder.score - 10);

  room.lastResult = {
    type: 'timeout',
    number: room.target,
    finderId: finder?.id || null,
    elapsedMs: ROUND_LIMIT_MS
  };
  room.target = null;
  room.roundStartedAt = null;
  room.round += 1;
  if (finder) room.currentCallerId = finder.id;
  return true;
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (endTimedOutRound(room)) {
      io.to(room.code).emit('game:timeout', room.lastResult);
      emitRoom(room);
    }
  }
}, 500);

io.on('connection', socket => {
  socket.on('room:create', ({ name, difficulty } = {}, callback = () => {}) => {
    const max = Number(difficulty);
    const selectedDifficulty = ALLOWED_DIFFICULTIES.has(max) ? max : 100;
    const code = makeCode();
    const room = {
      code,
      difficulty: selectedDifficulty,
      board: shuffledBoard(selectedDifficulty),
      found: [],
      players: [{ id: socket.id, name: sanitizeName(name), score: 0, finds: 0, totalFindMs: 0, wrongTaps: 0 }],
      currentCallerId: socket.id,
      target: null,
      round: 1,
      roundStartedAt: null,
      lastResult: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    callback({ ok: true, room: publicRoom(room) });
  });

  socket.on('room:join', ({ code, name } = {}, callback = () => {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.players.length >= 2) return callback({ ok: false, error: 'Room is full.' });

    room.players.push({ id: socket.id, name: sanitizeName(name), score: 0, finds: 0, totalFindMs: 0, wrongTaps: 0 });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    callback({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on('game:call', ({ number } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.players.length < 2) return callback({ ok: false, error: 'Waiting for Player 2.' });
    if (room.currentCallerId !== socket.id) return callback({ ok: false, error: "It's not your turn to call." });
    if (room.target !== null) return callback({ ok: false, error: 'The other player is still searching.' });

    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || n > room.difficulty) return callback({ ok: false, error: `Choose a number from 1 to ${room.difficulty}.` });
    if (room.found.includes(n)) return callback({ ok: false, error: 'That number has already been found.' });

    room.target = n;
    room.roundStartedAt = Date.now();
    room.lastResult = null;
    callback({ ok: true });
    io.to(room.code).emit('game:called', { number: n, startedAt: room.roundStartedAt, limitMs: ROUND_LIMIT_MS });
    emitRoom(room);
  });

  socket.on('game:find', ({ number } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.players.length < 2) return callback({ ok: false, error: 'Game has not started.' });
    if (room.currentCallerId === socket.id) return callback({ ok: false, error: 'The other player is searching.' });
    if (room.target === null) return callback({ ok: false, error: 'No number has been called yet.' });

    if (endTimedOutRound(room)) {
      io.to(room.code).emit('game:timeout', room.lastResult);
      emitRoom(room);
      return callback({ ok: false, error: 'Time ran out.' });
    }

    const n = Number(number);
    const finder = room.players.find(p => p.id === socket.id);
    if (!finder) return callback({ ok: false, error: 'Player not found.' });

    if (n !== room.target) {
      finder.wrongTaps += 1;
      finder.score = Math.max(0, finder.score - 5);
      socket.emit('game:miss', { number: n, penalty: 5 });
      callback({ ok: false, error: 'Not the called number.', penalty: 5 });
      emitRoom(room);
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - room.roundStartedAt);
    const speedBonus = Math.max(0, Math.round((ROUND_LIMIT_MS - elapsedMs) / 200));
    const points = 100 + speedBonus;

    finder.score += points;
    finder.finds += 1;
    finder.totalFindMs += elapsedMs;
    if (!room.found.includes(n)) room.found.push(n);

    room.lastResult = { type: 'found', number: n, finderId: socket.id, elapsedMs, points };
    room.target = null;
    room.roundStartedAt = null;
    room.round += 1;
    room.currentCallerId = socket.id;

    io.to(room.code).emit('game:found', room.lastResult);
    callback({ ok: true, points, elapsedMs });
    emitRoom(room);
  });

  socket.on('game:new', ({ difficulty } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    const requested = Number(difficulty);
    if (ALLOWED_DIFFICULTIES.has(requested)) room.difficulty = requested;

    room.board = shuffledBoard(room.difficulty);
    room.found = [];
    room.target = null;
    room.round = 1;
    room.roundStartedAt = null;
    room.lastResult = null;
    room.players.forEach(p => { p.score = 0; p.finds = 0; p.totalFindMs = 0; p.wrongTaps = 0; });
    room.currentCallerId = socket.id;

    callback({ ok: true, room: publicRoom(room) });
    io.to(room.code).emit('game:rematch', { by: socket.id, difficulty: room.difficulty });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    room.target = null;
    room.roundStartedAt = null;
    if (room.currentCallerId === socket.id) room.currentCallerId = room.players[0].id;
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Number Hunt v2 running on port ${PORT}`));
