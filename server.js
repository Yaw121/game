const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const rooms = {};

function makeBoard() {
  const nums = Array.from({ length: 130 }, (_, i) => i + 1);

  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }

  return nums;
}

function makeCode() {
  let code;

  do {
    code = Math.random().toString(36).substring(2, 7).toUpperCase();
  } while (rooms[code]);

  return code;
}

function sendRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit("room:update", room);
}

io.on("connection", (socket) => {

  socket.on("room:create", ({ name }, callback) => {
    const code = makeCode();

    rooms[code] = {
      code,
      players: [
        {
          id: socket.id,
          name: name || "Player 1",
          score: 0
        }
      ],
      board: makeBoard(),
      found: [],
      target: null,
      round: 1,
      gameStarted: false,
      currentCallerId: socket.id,
      winner: null
    };

    socket.join(code);
    socket.data.roomCode = code;

    callback({
      ok: true,
      room: rooms[code]
    });
  });


  socket.on("room:join", ({ code, name }, callback) => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms[code];

    if (!room) {
      return callback({
        ok: false,
        error: "Room not found."
      });
    }

    if (room.players.length >= 2) {
      return callback({
        ok: false,
        error: "Room is full."
      });
    }

    room.players.push({
      id: socket.id,
      name: name || "Player 2",
      score: 0
    });

    room.gameStarted = true;

    socket.join(code);
    socket.data.roomCode = code;

    callback({
      ok: true,
      room
    });

    sendRoom(code);
  });


  socket.on("game:call", ({ number }, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];

    if (!room) {
      return callback?.({
        ok: false,
        error: "Room not found."
      });
    }

    if (!room.gameStarted) {
      return callback?.({
        ok: false,
        error: "Waiting for Player 2."
      });
    }

    if (room.currentCallerId !== socket.id) {
      return callback?.({
        ok: false,
        error: "It is not your turn."
      });
    }

    number = Number(number);

    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > 130
    ) {
      return callback?.({
        ok: false,
        error: "Choose a number from 1 to 130."
      });
    }

    if (room.found.includes(number)) {
      return callback?.({
        ok: false,
        error: "That number has already been found."
      });
    }

    room.target = number;

    callback?.({ ok: true });

    sendRoom(code);
  });


  socket.on("game:find", ({ number }, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];

    if (!room) {
      return callback?.({
        ok: false,
        error: "Room not found."
      });
    }

    if (!room.gameStarted) {
      return callback?.({
        ok: false,
        error: "Game has not started."
      });
    }

    if (room.currentCallerId === socket.id) {
      return callback?.({
        ok: false,
        error: "The other player is searching."
      });
    }

    number = Number(number);

    if (number !== room.target) {
      socket.emit("game:miss", { number });

      return callback?.({
        ok: false,
        error: "Not the called number."
      });
    }

    if (!room.found.includes(number)) {
      room.found.push(number);
    }

    const finder = room.players.find(
      p => p.id === socket.id
    );

    if (finder) {
      finder.score += 1;
    }

    io.to(code).emit("game:found", {
      number,
      finderId: socket.id
    });

    room.target = null;
    room.round += 1;

    room.currentCallerId = socket.id;

    sendRoom(code);

    callback?.({ ok: true });
  });


  socket.on("game:new", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];

    if (!room) return;

    room.board = makeBoard();
    room.found = [];
    room.target = null;
    room.round = 1;
    room.winner = null;

    room.players.forEach(player => {
      player.score = 0;
    });

    if (room.players.length > 0) {
      room.currentCallerId = room.players[0].id;
    }

    sendRoom(code);
  });


  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms[code];

    if (!room) return;

    room.players = room.players.filter(
      player => player.id !== socket.id
    );

    if (room.players.length === 0) {
      delete rooms[code];
      return;
    }

    room.gameStarted = room.players.length >= 2;

    if (room.currentCallerId === socket.id) {
      room.currentCallerId = room.players[0].id;
    }

    sendRoom(code);
  });

});


const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Number Hunt running on port ${PORT}`);
});
