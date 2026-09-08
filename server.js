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

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();

    rooms[roomCode] = {
      players: [socket.id],
      calledNumber: null,
      foundNumbers: [],
      currentCaller: socket.id,
    };

    socket.join(roomCode);
    socket.emit("roomCreated", roomCode);
  });

  socket.on("joinRoom", (roomCode) => {
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("errorMessage", "Room is full");
      return;
    }

    room.players.push(socket.id);
    socket.join(roomCode);

    io.to(roomCode).emit("roomJoined", {
      roomCode,
      players: room.players.length,
    });
  });

  socket.on("callNumber", ({ roomCode, number }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.calledNumber = number;

    io.to(roomCode).emit("numberCalled", number);
  });

  socket.on("foundNumber", ({ roomCode, number }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.calledNumber === number && !room.foundNumbers.includes(number)) {
      room.foundNumbers.push(number);

      io.to(roomCode).emit("numberFound", number);

      room.calledNumber = null;
    }
  });

  socket.on("disconnect", () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];

      room.players = room.players.filter(
        (playerId) => playerId !== socket.id
      );

      if (room.players.length === 0) {
        delete rooms[roomCode];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
