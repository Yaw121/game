const socket = io();
let room = null;
let myId = null;
let missNumber = null;
let selectedDifficulty = 100;
let selectedMode = 'first5';
let rafId = null;
let countdownRaf = null;
let lastEndedStamp = null;

const $ = s => document.querySelector(s);
const lobby = $('#lobby');
const game = $('#game');
const board = $('#board');
const lobbyMsg = $('#lobbyMsg');
const gameMsg = $('#gameMsg');

const playerTokenKey = 'numberHuntPlayerToken';
const roomCodeKey = 'numberHuntRoomCode';
let playerToken = localStorage.getItem(playerTokenKey) || cryptoRandomToken();
localStorage.setItem(playerTokenKey, playerToken);

function cryptoRandomToken() {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`; }
}

function modeName(mode) {
  if (mode === 'first5') return 'First to 5';
  if (mode === 'first10') return 'First to 10';
  return '2 Minute Match';
}

function modeShort(mode) {
  if (mode === 'first5') return ['FIRST TO', '5'];
  if (mode === 'first10') return ['FIRST TO', '10'];
  return ['MATCH', '2:00'];
}

function vibrate(pattern = 25) { try { navigator.vibrate?.(pattern); } catch {} }
function beep(kind = 'good') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = kind === 'good' ? 740 : kind === 'go' ? 520 : 180;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch {}
}
function flash(type) {
  const el = $('#flash');
  el.className = `flash ${type}`;
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => el.classList.remove('show'), 180);
}
function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
function nameValue() { return ($('#nameInput').value.trim() || 'Player').slice(0, 18); }

socket.on('connect', () => {
  const savedCode = localStorage.getItem(roomCodeKey);
  if (savedCode && playerToken && !room) {
    socket.emit('room:resume', { code: savedCode, playerToken }, res => {
      if (res?.ok) {
        myId = res.playerId;
        playerToken = res.playerToken || playerToken;
        room = res.room;
        enterGame();
        render();
        showToast('Reconnected to your match');
      } else {
        localStorage.removeItem(roomCodeKey);
      }
    });
  }
});
socket.on('disconnect', () => showToast('Connection lost… reconnecting'));

$('#difficultyPicker').addEventListener('click', e => {
  const btn = e.target.closest('.choiceBtn'); if (!btn) return;
  selectedDifficulty = Number(btn.dataset.value);
  document.querySelectorAll('.choiceBtn').forEach(b => b.classList.toggle('selected', b === btn));
  vibrate(10);
});
$('#modePicker').addEventListener('click', e => {
  const btn = e.target.closest('.modeBtn'); if (!btn) return;
  selectedMode = btn.dataset.value;
  document.querySelectorAll('.modeBtn').forEach(b => b.classList.toggle('selected', b === btn));
  vibrate(10);
});

$('#createBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:create', { name: nameValue(), difficulty: selectedDifficulty, mode: selectedMode, playerToken }, res => {
    if (!res?.ok) return lobbyMsg.textContent = res?.error || 'Could not create room.';
    myId = res.playerId; playerToken = res.playerToken || playerToken; room = res.room;
    localStorage.setItem(playerTokenKey, playerToken); localStorage.setItem(roomCodeKey, room.code);
    enterGame(); render();
  });
};

$('#joinBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:join', { code: $('#codeInput').value, name: nameValue(), playerToken }, res => {
    if (!res?.ok) return lobbyMsg.textContent = res?.error || 'Could not join room.';
    myId = res.playerId; playerToken = res.playerToken || playerToken; room = res.room;
    localStorage.setItem(playerTokenKey, playerToken); localStorage.setItem(roomCodeKey, room.code);
    enterGame(); render();
  });
};
$('#codeInput').addEventListener('input', e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));

const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('#codeInput').value = urlRoom.toUpperCase().slice(0, 5);

function enterGame() { lobby.classList.add('hidden'); game.classList.remove('hidden'); }

socket.on('room:update', data => {
  room = data;
  render();
  if (room.status === 'ended') showResultsOnce();
});
socket.on('game:called', () => { vibrate([25,35,25]); renderCountdown(); renderTimer(); });
socket.on('game:found', ({ number, finderId, finderName, elapsedMs, points }) => {
  const secs = (elapsedMs / 1000).toFixed(2);
  if (finderId === myId) {
    showToast(`⚡ Found ${number} in ${secs}s  +${points}`); vibrate([30,35,60]); beep('good'); flash('good'); savePersonalBest(elapsedMs);
  } else showToast(`⚡ ${finderName || 'Opponent'} found ${number} in ${secs}s`);
});
socket.on('game:timeout', ({ number, finderId }) => {
  if (finderId === myId) { showToast(`Time! ${number} was the target. −10`); vibrate([80,60,80]); beep('bad'); flash('bad'); }
  else showToast(`Time! ${number} wasn't found.`);
});
socket.on('game:miss', ({ number, penalty }) => {
  missNumber = number; renderBoard(); showToast(`Wrong number −${penalty}`); vibrate(60); beep('bad'); flash('bad');
  setTimeout(() => { missNumber = null; renderBoard(); }, 430);
});
socket.on('game:rematch', () => { $('#resultModal').classList.add('hidden'); lastEndedStamp = null; showToast('Rematch started'); });
socket.on('game:ended', data => { if (data?.room) room = data.room; render(); showResultsOnce(true); });

function shareRoom() {
  if (!room) return;
  const url = new URL(location.href); url.searchParams.set('room', room.code);
  const shareText = `Join my Number Hunt room ${room.code} — ${modeName(room.mode)}.`;
  if (navigator.share) {
    navigator.share({ title: 'Number Hunt', text: shareText, url: url.toString() }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url.toString()).then(() => showToast('Invite link copied')).catch(() => showToast(`Room code: ${room.code}`));
  }
}
$('#roomCode').onclick = shareRoom;
$('#inviteBtn').onclick = shareRoom;

$('#callBtn').onclick = callNumber;
$('#numberInput').addEventListener('keydown', e => { if (e.key === 'Enter') callNumber(); });
function callNumber() {
  const number = Number($('#numberInput').value); gameMsg.textContent = '';
  socket.emit('game:call', { number }, res => {
    if (!res?.ok) gameMsg.textContent = res?.error || 'Could not call that number.';
    else $('#numberInput').value = '';
  });
}
$('#randomBtn').onclick = () => {
  gameMsg.textContent = '';
  socket.emit('game:random', {}, res => {
    if (!res?.ok) return gameMsg.textContent = res?.error || 'Could not choose a number.';
    $('#numberInput').value = res.number;
    vibrate(15);
    showToast(`Random pick: ${res.number}`);
  });
};

$('#rematchBtn').onclick = startRematch;
function startRematch() {
  if (!room) return;
  socket.emit('game:new', { difficulty: room.difficulty, mode: room.mode }, res => {
    if (!res?.ok) gameMsg.textContent = res?.error || 'Could not start rematch.';
    else $('#resultModal').classList.add('hidden');
  });
}
$('#closeStatsBtn').onclick = () => $('#resultModal').classList.add('hidden');

function render() {
  if (!room) return;
  $('#roomCode').textContent = room.code;
  $('#roundNum').textContent = room.round;
  const [modeLabel, modeValue] = modeShort(room.mode); $('#modeLabel').textContent = modeLabel; $('#modeValue').textContent = modeValue;
  $('#numberInput').max = room.difficulty; $('#numberInput').placeholder = `1–${room.difficulty}`;
  document.documentElement.style.setProperty('--cols', room.difficulty <= 50 ? 8 : room.difficulty <= 100 ? 10 : 12);
  renderScore(); renderStatus(); renderBoard(); renderTimer(); renderCountdown();
}

function renderScore() {
  $('#scoreBar').innerHTML = room.players.map(p => {
    const avg = p.finds ? `${(p.totalFindMs / p.finds / 1000).toFixed(2)}s avg` : '— avg';
    const fast = p.fastestFindMs != null ? `${(p.fastestFindMs / 1000).toFixed(2)}s best` : '— best';
    return `<div class="playerCard ${p.id === room.currentCallerId ? 'active' : ''} ${p.connected ? '' : 'offline'}">
      <div class="playerMain"><span class="playerName">${escapeHtml(p.name)} ${p.id === myId ? '<em>YOU</em>' : ''}${p.connected ? '' : ' · offline'}</span><span class="playerStats">${p.finds} finds · ${avg} · ${fast} · ${p.wrongTaps} misses</span></div>
      <span class="score">${p.score}</span>
    </div>`;
  }).join('');
}

function renderStatus() {
  const waiting = !room.gameStarted || room.players.length < 2;
  const iAmCaller = room.currentCallerId === myId;
  const caller = room.players.find(p => p.id === room.currentCallerId);
  const someoneOffline = room.players.length === 2 && room.players.some(p => !p.connected);
  $('#reconnectNotice').classList.toggle('hidden', !someoneOffline);
  $('#waitingControls').classList.toggle('hidden', !waiting);
  $('#callerControls').classList.add('hidden'); $('#finderControls').classList.add('hidden');

  if (room.status === 'ended') {
    $('#turnText').textContent = 'Match complete'; $('#targetText').textContent = 'View results or start a rematch'; return;
  }
  if (waiting) { $('#turnText').textContent = 'Waiting for Player 2…'; $('#targetText').textContent = 'Share the room code'; return; }
  if (someoneOffline) { $('#turnText').textContent = 'Opponent reconnecting…'; $('#targetText').textContent = 'Their seat is being held'; return; }

  if (iAmCaller) {
    $('#callerControls').classList.toggle('hidden', room.target !== null);
    $('#turnText').textContent = room.target === null ? 'Your turn to call' : 'They are searching…';
    $('#targetText').textContent = room.target === null ? 'Pick an uncircled number' : `You called ${room.target}`;
  } else {
    $('#finderControls').classList.remove('hidden');
    const inCountdown = room.target !== null && Date.now() < room.searchStartsAt;
    $('#turnText').textContent = room.target === null ? `${caller?.name || 'Opponent'} is choosing…` : inCountdown ? 'GET READY' : `FIND ${room.target}`;
    $('#targetText').textContent = room.target === null ? 'Get ready' : inCountdown ? 'Search starts after the countdown' : 'Tap it before time runs out';
  }
}

function renderBoard() {
  if (!room) return;
  const found = new Set(room.found); board.innerHTML = '';
  room.board.forEach((n, idx) => {
    const btn = document.createElement('button'); btn.className = 'num';
    if (found.has(n)) btn.classList.add('found'); if (missNumber === n) btn.classList.add('miss');
    const rotation = ((idx * 17) % 17) - 8, dx = ((idx * 11) % 7) - 3, dy = ((idx * 13) % 7) - 3;
    btn.style.setProperty('--r', `${rotation}deg`); btn.style.setProperty('--dx', `${dx}px`); btn.style.setProperty('--dy', `${dy}px`);
    btn.textContent = n; btn.disabled = found.has(n); btn.onclick = () => onNumberTap(n); board.appendChild(btn);
  });
}

function onNumberTap(n) {
  if (!room || !room.gameStarted || room.status !== 'playing') return;
  const iAmCaller = room.currentCallerId === myId;
  if (iAmCaller && room.target === null) { $('#numberInput').value = n; vibrate(8); return; }
  if (!iAmCaller && room.target !== null) {
    if (Date.now() < room.searchStartsAt) return showToast('Wait for GO!');
    gameMsg.textContent = '';
    socket.emit('game:find', { number: n }, res => {
      if (!res?.ok && !['Not the called number.','Time ran out.','Wait for GO!'].includes(res?.error)) gameMsg.textContent = res?.error || '';
    });
  }
}

function renderCountdown() {
  cancelAnimationFrame(countdownRaf);
  const overlay = $('#countdown'), text = $('#countdownText');
  if (!room?.target || !room.searchStartsAt || room.currentCallerId === myId || Date.now() >= room.searchStartsAt) {
    overlay.classList.add('hidden'); return;
  }
  overlay.classList.remove('hidden');
  const tick = () => {
    if (!room?.target || !room.searchStartsAt) return overlay.classList.add('hidden');
    const left = room.searchStartsAt - Date.now();
    if (left <= 0) {
      text.textContent = 'GO!'; overlay.classList.add('go'); beep('go'); vibrate([20,20,35]);
      setTimeout(() => { overlay.classList.add('hidden'); overlay.classList.remove('go'); }, 420); return;
    }
    text.textContent = Math.max(1, Math.ceil(left / 1000));
    countdownRaf = requestAnimationFrame(tick);
  };
  tick();
}

function renderTimer() {
  cancelAnimationFrame(rafId);
  const bar = $('#timerBar'), text = $('#timerText'), label = $('#timerLabel');
  const tick = () => {
    if (!room) return;
    if (room.mode === 'timed' && room.status === 'playing' && room.matchEndsAt) {
      const matchLeft = Math.max(0, room.matchEndsAt - Date.now());
      const mins = Math.floor(matchLeft / 60000), secs = Math.floor((matchLeft % 60000) / 1000).toString().padStart(2,'0');
      $('#modeValue').textContent = `${mins}:${secs}`;
    }
    if (!room.target || !room.searchStartsAt || Date.now() < room.searchStartsAt) {
      bar.style.transform = 'scaleX(1)'; bar.classList.remove('danger'); text.textContent = '20.0'; label.textContent = room.target ? 'READY' : 'READY';
      rafId = requestAnimationFrame(tick); return;
    }
    const limit = room.roundLimitMs || 20000, left = Math.max(0, limit - (Date.now() - room.searchStartsAt));
    text.textContent = (left / 1000).toFixed(1); label.textContent = 'TIME'; bar.style.transform = `scaleX(${left / limit})`; bar.classList.toggle('danger', left <= 5000);
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function showResultsOnce(force = false) {
  if (!room || room.status !== 'ended') return;
  const stamp = `${room.code}:${room.endedReason}:${room.round}:${room.winnerId}`;
  if (!force && stamp === lastEndedStamp) return; lastEndedStamp = stamp;
  const winner = room.players.find(p => p.id === room.winnerId);
  $('#winnerTitle').textContent = room.winnerId ? (room.winnerId === myId ? 'You win! 🏆' : `${winner?.name || 'Opponent'} wins!`) : 'It’s a tie!';
  $('#winnerSubtitle').textContent = room.endedReason === 'time' ? 'The 2-minute clock expired.' : room.endedReason?.startsWith('first-to-') ? `${modeName(room.mode)} completed.` : 'Board complete.';
  $('#finalStats').innerHTML = room.players.map(p => {
    const avg = p.finds ? `${(p.totalFindMs / p.finds / 1000).toFixed(2)}s` : '—';
    const fast = p.fastestFindMs != null ? `${(p.fastestFindMs / 1000).toFixed(2)}s` : '—';
    const accuracy = p.attempts ? `${Math.round((p.finds / p.attempts) * 100)}%` : '—';
    return `<div class="statCard"><div class="statTitle"><span>${escapeHtml(p.name)} ${p.id === myId ? '· YOU' : ''}</span><strong>${p.score} pts</strong></div><div class="statGrid"><div><span>FINDS</span><strong>${p.finds}</strong></div><div><span>FASTEST</span><strong>${fast}</strong></div><div><span>AVERAGE</span><strong>${avg}</strong></div><div><span>ACCURACY</span><strong>${accuracy}</strong></div></div></div>`;
  }).join('');
  const best = Number(localStorage.getItem('numberHuntBestMs'));
  if (Number.isFinite(best) && best > 0) $('#winnerSubtitle').textContent += ` Your personal best: ${(best / 1000).toFixed(2)}s.`;
  $('#resultModal').classList.remove('hidden');
  if (room.winnerId === myId) { beep('good'); vibrate([40,30,40,30,90]); }
}

function savePersonalBest(ms) {
  const key = 'numberHuntBestMs'; const prev = Number(localStorage.getItem(key));
  if (!prev || ms < prev) { localStorage.setItem(key, String(ms)); showToast(`🏅 New personal best: ${(ms / 1000).toFixed(2)}s`); }
}

function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
