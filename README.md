# Number Hunt Online v3

Two-player real-time scrambled-number hunt optimized for phones.

## New in v3
- Match modes: First to 5, First to 10, and 2-minute timed match
- 3…2…1…GO countdown before the finder timer starts
- Winner screen and one-tap rematch
- Post-match stats: finds, fastest find, average find time, accuracy, score
- Random-number button for the caller
- Live “found in X seconds” feedback
- Personal-best tracking in the browser
- Reconnect protection: a player can refresh, lock their phone, or briefly lose signal and reclaim their seat for 90 seconds
- One-tap invite link with the room code embedded
- Sticky mobile HUD, scoreboard, and controls for better phone play
- Existing v2 scoring, penalties, vibration, sound, and difficulty modes retained

## Deploy on Render
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Root directory: leave blank

Replace the six repository-root files with this v3 set, commit, then use Render → Manual Deploy → Deploy latest commit.


## v3.1 room controls
- Any player can use **Leave Game** to leave immediately.
- If the host leaves, the room closes for everyone.
- The host gets a **Remove Player** button whenever an opponent is in the room.
- Removed players are returned to the lobby and the host can invite someone else into the same room.
- Refreshes and short connection drops still use the 90-second reconnect protection; only the explicit Leave Game action removes the seat immediately.
