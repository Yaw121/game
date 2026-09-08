const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = new Map();
const ALLOWED_DIFFICULTIES = new Set([50, 100, 150]);
const ALLOWED_MODES = new Set(['first5', 'first10', 'timed']);
const ALLOWED_STYLES = new Set(['classic', 'duel']);
const ROUND_LIMIT_MS = 20000;
const COUNTDOWN_MS = 3000;
const TIMED_MATCH_MS = 120000;
const RECONNECT_GRACE_MS = 90000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makePlayerId() {
  return `p_${crypto.randomBytes(6).toString('hex')}`;
}

function shuffledBoard(maxNumber) {
  const nums = Array.from({ length: maxNumber }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

function sanitizeName(name) {
  const cleaned = String(name || 'Player').trim().replace(/[<>]/g, '').slice(0, 18);
  return cleaned || 'Player';
}

function modeTarget(mode) {
  if (mode === 'first5') return 5;
  if (mode === 'first10') return 10;
  return null;
}

function findPlayerByToken(room, token) {
  return room.players.find(p => p.token === token);
}

function findPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function getRoomForSocket(socket) {
  return rooms.get(socket.data.roomCode);
}

function getPlayerForSocket(socket, room) {
  return room?.players.find(p => p.id === socket.data.playerId);
}

function roomReady(room) {
  return room.players.length === 2 && room.players.every(p => p.connected);
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    difficulty: room.difficulty,
    mode: room.mode,
    playStyle: room.playStyle,
    modeTarget: modeTarget(room.mode),
    board: room.board,
    found: room.found,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      finds: p.finds,
      totalFindMs: p.totalFindMs,
      fastestFindMs: p.fastestFindMs,
      wrongTaps: p.wrongTaps,
      attempts: p.attempts,
      connected: p.connected
    })),
    currentCallerId: room.currentCallerId,
    target: room.target,
    round: room.round,
    gameStarted: room.players.length === 2,
    bothConnected: roomReady(room),
    countdownStartedAt: room.countdownStartedAt,
    searchStartsAt: room.searchStartsAt,
    roundLimitMs: ROUND_LIMIT_MS,
    countdownMs: COUNTDOWN_MS,
    matchStartedAt: room.matchStartedAt,
    matchLimitMs: room.mode === 'timed' ? TIMED_MATCH_MS : null,
    matchEndsAt: room.mode === 'timed' && room.matchStartedAt ? room.matchStartedAt + TIMED_MATCH_MS : null,
    lastResult: room.lastResult || null,
    status: room.status,
    winnerId: room.winnerId,
    endedReason: room.endedReason,
    createdAt: room.createdAt,
    endedAt: room.endedAt || null
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}

function resetPlayerStats(player) {
  player.score = 0;
  player.finds = 0;
  player.totalFindMs = 0;
  player.fastestFindMs = null;
  player.wrongTaps = 0;
  player.attempts = 0;
}

function chooseWinner(room) {
  if (!room.players.length) return null;
  const sorted = [...room.players].sort((a, b) => {
    if (b.finds !== a.finds) return b.finds - a.finds;
    if (b.score !== a.score) return b.score - a.score;
    const aAvg = a.finds ? a.totalFindMs / a.finds : Infinity;
    const bAvg = b.finds ? b.totalFindMs / b.finds : Infinity;
    return aAvg - bAvg;
  });
  if (sorted.length < 2) return sorted[0]?.id || null;
  const a = sorted[0], b = sorted[1];
  const aAvg = a.finds ? a.totalFindMs / a.finds : Infinity;
  const bAvg = b.finds ? b.totalFindMs / b.finds : Infinity;
  const exactTie = a.finds === b.finds && a.score === b.score && Math.round(aAvg) === Math.round(bAvg);
  return exactTie ? null : a.id;
}

function finishMatch(room, reason) {
  if (room.status === 'ended') return;
  room.status = 'ended';
  room.target = null;
  room.countdownStartedAt = null;
  room.searchStartsAt = null;
  room.winnerId = chooseWinner(room);
  room.endedReason = reason;
  room.endedAt = Date.now();
  io.to(room.code).emit('game:ended', {
    winnerId: room.winnerId,
    reason,
    room: publicRoom(room)
  });
  emitRoom(room);
}

function maybeFinishFirstTo(room) {
  const target = modeTarget(room.mode);
  if (!target) return false;
  const winner = room.players.find(p => p.finds >= target);
  if (!winner) return false;
  room.winnerId = winner.id;
  room.status = 'ended';
  room.target = null;
  room.countdownStartedAt = null;
  room.searchStartsAt = null;
  room.endedReason = `first-to-${target}`;
  room.endedAt = Date.now();
  io.to(room.code).emit('game:ended', {
    winnerId: winner.id,
    reason: room.endedReason,
    room: publicRoom(room)
  });
  emitRoom(room);
  return true;
}

function scheduleDuelRound(room, delayMs = 900) {
  if (room.playStyle !== 'duel') return;
  const code = room.code;
  setTimeout(() => {
    const live = rooms.get(code);
    if (!live || live !== room || live.playStyle !== 'duel' || live.status !== 'playing' || live.target !== null || !roomReady(live)) return;
    const unused = live.board.filter(n => !live.found.includes(n));
    if (!unused.length) return finishMatch(live, 'board-complete');
    const number = unused[Math.floor(Math.random() * unused.length)];
    live.target = number;
    live.countdownStartedAt = Date.now();
    live.searchStartsAt = live.countdownStartedAt + COUNTDOWN_MS;
    live.lastResult = null;
    io.to(live.code).emit('game:called', { number, duel: true, countdownStartedAt: live.countdownStartedAt, searchStartsAt: live.searchStartsAt, limitMs: ROUND_LIMIT_MS });
    emitRoom(live);
  }, delayMs);
}

function endTimedOutRound(room) {
  if (room.status !== 'playing' || room.target === null || !room.searchStartsAt) return false;
  const now = Date.now();
  if (now < room.searchStartsAt + ROUND_LIMIT_MS) return false;

  let finderId = null;
  if (room.playStyle === 'duel') {
    room.players.forEach(p => { p.score = Math.max(0, p.score - 10); p.attempts += 1; });
  } else {
    const finder = room.players.find(p => p.id !== room.currentCallerId);
    if (finder) { finder.score = Math.max(0, finder.score - 10); finder.attempts += 1; finderId = finder.id; }
  }

  room.lastResult = { type: 'timeout', number: room.target, finderId, elapsedMs: ROUND_LIMIT_MS, duel: room.playStyle === 'duel' };
  room.target = null;
  room.countdownStartedAt = null;
  room.searchStartsAt = null;
  room.round += 1;
  if (room.playStyle === 'classic' && finderId) room.currentCallerId = finderId;
  io.to(room.code).emit('game:timeout', room.lastResult);
  if (room.playStyle === 'duel') scheduleDuelRound(room);
  return true;
}

function startMatchIfReady(room) {
  if (room.players.length === 2 && room.status === 'waiting') {
    room.status = 'playing';
    room.matchStartedAt = Date.now();
    room.lastResult = null;
    if (room.playStyle === 'duel') scheduleDuelRound(room, 700);
  }
}

function startFreshMatch(room, starterId) {
  room.board = shuffledBoard(room.difficulty);
  room.found = [];
  room.target = null;
  room.round = 1;
  room.countdownStartedAt = null;
  room.searchStartsAt = null;
  room.lastResult = null;
  room.winnerId = null;
  room.endedReason = null;
  room.endedAt = null;
  room.players.forEach(resetPlayerStats);
  room.currentCallerId = room.playStyle === 'duel' ? null : (starterId || room.players[0]?.id || null);
  room.status = room.players.length === 2 ? 'playing' : 'waiting';
  room.matchStartedAt = room.players.length === 2 ? Date.now() : null;
  if (room.status === 'playing' && room.playStyle === 'duel') scheduleDuelRound(room, 700);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.status === 'playing' && room.mode === 'timed' && room.matchStartedAt && now >= room.matchStartedAt + TIMED_MATCH_MS) {
      finishMatch(room, 'time');
      continue;
    }

    if (endTimedOutRound(room)) emitRoom(room);

    for (const p of [...room.players]) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt >= RECONNECT_GRACE_MS) {
        room.players = room.players.filter(x => x.id !== p.id);
        if (room.currentCallerId === p.id) room.currentCallerId = room.players[0]?.id || null;
        room.target = null;
        room.countdownStartedAt = null;
        room.searchStartsAt = null;
        if (room.players.length < 2 && room.status !== 'ended') room.status = 'waiting';
        emitRoom(room);
      }
    }

    if (room.players.length === 0) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince >= EMPTY_ROOM_TTL_MS) rooms.delete(code);
    } else {
      room.emptySince = null;
    }
  }
}, 500);

io.on('connection', socket => {
  socket.on('room:create', ({ name, difficulty, mode, playStyle, playerToken } = {}, callback = () => {}) => {
    const selectedDifficulty = ALLOWED_DIFFICULTIES.has(Number(difficulty)) ? Number(difficulty) : 100;
    const selectedMode = ALLOWED_MODES.has(mode) ? mode : 'first5';
    const selectedStyle = ALLOWED_STYLES.has(playStyle) ? playStyle : 'classic';
    const code = makeCode();
    const player = {
      id: makePlayerId(), token: String(playerToken || crypto.randomUUID()), socketId: socket.id,
      name: sanitizeName(name), connected: true, disconnectedAt: null,
      score: 0, finds: 0, totalFindMs: 0, fastestFindMs: null, wrongTaps: 0, attempts: 0
    };
    const room = {
      code, hostId: player.id, difficulty: selectedDifficulty, mode: selectedMode, playStyle: selectedStyle,
      board: shuffledBoard(selectedDifficulty), found: [], players: [player],
      currentCallerId: player.id, target: null, round: 1,
      countdownStartedAt: null, searchStartsAt: null,
      matchStartedAt: null, lastResult: null,
      status: 'waiting', winnerId: null, endedReason: null,
      createdAt: Date.now(), endedAt: null, emptySince: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    callback({ ok: true, room: publicRoom(room), playerId: player.id, playerToken: player.token });
  });

  socket.on('room:join', ({ code, name, playerToken } = {}, callback = () => {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ ok: false, error: 'Room not found.' });

    const token = String(playerToken || '');
    const existing = token ? findPlayerByToken(room, token) : null;
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      existing.disconnectedAt = null;
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.playerId = existing.id;
      startMatchIfReady(room);
      callback({ ok: true, room: publicRoom(room), playerId: existing.id, playerToken: existing.token, resumed: true });
      emitRoom(room);
      return;
    }

    if (room.players.length >= 2) return callback({ ok: false, error: 'Room is full.' });
    const player = {
      id: makePlayerId(), token: token || crypto.randomUUID(), socketId: socket.id,
      name: sanitizeName(name), connected: true, disconnectedAt: null,
      score: 0, finds: 0, totalFindMs: 0, fastestFindMs: null, wrongTaps: 0, attempts: 0
    };
    room.players.push(player);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = player.id;
    startMatchIfReady(room);
    callback({ ok: true, room: publicRoom(room), playerId: player.id, playerToken: player.token });
    emitRoom(room);
  });

  socket.on('room:resume', ({ code, playerToken } = {}, callback = () => {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ ok: false, error: 'Room expired.' });
    const player = findPlayerByToken(room, String(playerToken || ''));
    if (!player) return callback({ ok: false, error: 'Could not restore your seat.' });

    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = null;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = player.id;
    startMatchIfReady(room);
    callback({ ok: true, room: publicRoom(room), playerId: player.id, playerToken: player.token });
    emitRoom(room);
  });


  socket.on('room:leave', (_payload = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: true });
    const player = getPlayerForSocket(socket, room);
    if (!player) return callback({ ok: true });

    // If the host leaves, close the room for everyone immediately.
    if (player.id === room.hostId) {
      const otherPlayers = room.players.filter(p => p.id !== player.id);
      for (const other of otherPlayers) {
        const otherSocket = io.sockets.sockets.get(other.socketId);
        if (otherSocket) {
          otherSocket.emit('room:closed', { message: 'The host ended the room.' });
          otherSocket.leave(room.code);
          otherSocket.data.roomCode = null;
          otherSocket.data.playerId = null;
        }
      }
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      rooms.delete(room.code);
      return callback({ ok: true, closed: true });
    }

    // A guest can leave immediately without waiting for reconnect grace.
    room.players = room.players.filter(p => p.id !== player.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    startFreshMatch(room, room.hostId);
    callback({ ok: true, closed: false });
    emitRoom(room);
  });

  socket.on('room:kick', ({ playerId } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (socket.data.playerId !== room.hostId) return callback({ ok: false, error: 'Only the host can remove a player.' });

    const target = room.players.find(p => p.id === playerId && p.id !== room.hostId);
    if (!target) return callback({ ok: false, error: 'Player not found.' });

    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('room:kicked', { message: 'The host removed you from the room.' });
      targetSocket.leave(room.code);
      targetSocket.data.roomCode = null;
      targetSocket.data.playerId = null;
    }

    room.players = room.players.filter(p => p.id !== target.id);
    startFreshMatch(room, room.hostId);
    callback({ ok: true });
    emitRoom(room);
  });

  socket.on('game:random', (_payload = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.status !== 'playing') return callback({ ok: false, error: 'Match is not active.' });
    if (room.playStyle === 'duel') return callback({ ok: false, error: 'Speed Duel chooses the number automatically.' });
    if (room.currentCallerId !== socket.data.playerId) return callback({ ok: false, error: "It's not your turn to call." });
    if (room.target !== null) return callback({ ok: false, error: 'The other player is still searching.' });
    const unused = room.board.filter(n => !room.found.includes(n));
    if (!unused.length) return finishMatch(room, 'board-complete');
    const number = unused[Math.floor(Math.random() * unused.length)];
    callback({ ok: true, number });
  });

  socket.on('game:call', ({ number } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.status !== 'playing') return callback({ ok: false, error: room.status === 'ended' ? 'Match is over. Start a rematch.' : 'Waiting for Player 2.' });
    if (room.players.length < 2) return callback({ ok: false, error: 'Waiting for Player 2.' });
    if (room.playStyle === 'duel') return callback({ ok: false, error: 'Speed Duel chooses the number automatically.' });
    if (room.currentCallerId !== socket.data.playerId) return callback({ ok: false, error: "It's not your turn to call." });
    if (room.target !== null) return callback({ ok: false, error: 'The other player is still searching.' });

    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || n > room.difficulty) return callback({ ok: false, error: `Choose a number from 1 to ${room.difficulty}.` });
    if (room.found.includes(n)) return callback({ ok: false, error: 'That number has already been found.' });

    room.target = n;
    room.countdownStartedAt = Date.now();
    room.searchStartsAt = room.countdownStartedAt + COUNTDOWN_MS;
    room.lastResult = null;
    callback({ ok: true, number: n });
    io.to(room.code).emit('game:called', { number: n, countdownStartedAt: room.countdownStartedAt, searchStartsAt: room.searchStartsAt, limitMs: ROUND_LIMIT_MS });
    emitRoom(room);
  });

  socket.on('game:find', ({ number } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (room.status !== 'playing') return callback({ ok: false, error: 'Match is not active.' });
    if (room.playStyle === 'classic' && room.currentCallerId === socket.data.playerId) return callback({ ok: false, error: 'The other player is searching.' });
    if (room.target === null) return callback({ ok: false, error: room.playStyle === 'duel' ? 'Get ready for the next number.' : 'No number has been called yet.' });
    if (Date.now() < room.searchStartsAt) return callback({ ok: false, error: 'Wait for GO!' });

    if (endTimedOutRound(room)) {
      emitRoom(room);
      return callback({ ok: false, error: 'Time ran out.' });
    }

    const n = Number(number);
    const finder = getPlayerForSocket(socket, room);
    if (!finder) return callback({ ok: false, error: 'Player not found.' });
    finder.attempts += 1;

    if (n !== room.target) {
      finder.wrongTaps += 1;
      finder.score = Math.max(0, finder.score - 5);
      socket.emit('game:miss', { number: n, penalty: 5 });
      callback({ ok: false, error: 'Not the called number.', penalty: 5 });
      emitRoom(room);
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - room.searchStartsAt);
    const speedBonus = Math.max(0, Math.round((ROUND_LIMIT_MS - elapsedMs) / 200));
    const points = 100 + speedBonus;

    finder.score += points;
    finder.finds += 1;
    finder.totalFindMs += elapsedMs;
    finder.fastestFindMs = finder.fastestFindMs === null ? elapsedMs : Math.min(finder.fastestFindMs, elapsedMs);
    if (!room.found.includes(n)) room.found.push(n);

    room.lastResult = { type: 'found', number: n, finderId: finder.id, finderName: finder.name, elapsedMs, points, duel: room.playStyle === 'duel' };
    room.target = null;
    room.countdownStartedAt = null;
    room.searchStartsAt = null;
    room.round += 1;
    if (room.playStyle === 'classic') room.currentCallerId = finder.id;

    io.to(room.code).emit('game:found', room.lastResult);
    callback({ ok: true, points, elapsedMs });
    if (!maybeFinishFirstTo(room)) {
      emitRoom(room);
      if (room.playStyle === 'duel') scheduleDuelRound(room);
    }
  });

  socket.on('game:new', ({ difficulty, mode, playStyle } = {}, callback = () => {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback({ ok: false, error: 'Room not found.' });
    if (ALLOWED_DIFFICULTIES.has(Number(difficulty))) room.difficulty = Number(difficulty);
    if (ALLOWED_MODES.has(mode)) room.mode = mode;
    if (ALLOWED_STYLES.has(playStyle)) room.playStyle = playStyle;
    startFreshMatch(room, socket.data.playerId);
    callback({ ok: true, room: publicRoom(room) });
    io.to(room.code).emit('game:rematch', { by: socket.data.playerId, difficulty: room.difficulty, mode: room.mode, playStyle: room.playStyle });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const player = getPlayerForSocket(socket, room);
    if (!player) return;
    if (player.socketId !== socket.id) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Number Hunt v4 running on port ${PORT}`));
