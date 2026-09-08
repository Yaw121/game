# Number Hunt Online

A two-player real-time scrambled-number game. One player calls a number, the other races to find it and tap it. When found, the number is circled on both players' screens instantly. The finder becomes the next caller.

## Features
- Randomized board with numbers 1–130
- Two-player private rooms with shareable 5-character code
- Live synchronization with Socket.IO
- Caller/finder turn switching
- Correct finds circle the number on both devices
- Wrong taps give local visual feedback
- Scorekeeping and round count
- Responsive layout for phone/tablet/desktop
- New-game reset with a fresh scramble

## Run locally
1. Install Node.js 18+.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Play across the internet
Deploy the folder to a Node-compatible host such as Render, Railway, Fly.io, or a VPS. The app reads `process.env.PORT`, so most hosts work without code changes.

For a quick same-Wi-Fi test, run the app on one computer and open `http://YOUR-COMPUTER-LAN-IP:3000` on the second device.

## Game flow
1. Player 1 creates a room and shares the room code.
2. Player 2 joins.
3. The caller chooses a number from 1–130.
4. The finder taps the matching number on the scrambled board.
5. The server validates it and circles the correct number on both screens.
6. The finder becomes the next caller.
