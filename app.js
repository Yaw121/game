const socket = io();
let room = null;
let myId = null;
let missNumber = null;
let selectedDifficulty = 100;
let rafId = null;

const $ = s => document.querySelector(s);
const lobby = $('#lobby');
const game = $('#game');
const board = $('#board');
const lobbyMsg = $('#lobbyMsg');
const gameMsg = $('#gameMsg');

socket.on('connect', () => { myId = socket.id; });
socket.on('disconnect', () => showToast('Connection lost… reconnecting'));

function vibrate(pattern = 25) {
  try { navigator.vibrate?.(pattern); } catch {}
}

function beep(kind = 'good') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = kind === 'good' ? 740 : 180;
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
  showToast.t = setTimeout(() => el.classList.remove('show'), 1900);
}

function nameValue() {
  return ($('#nameInput').value.trim() || 'Player').slice(0, 18);
}

$('#difficultyPicker').addEventListener('click', e => {
  const btn = e.target.closest('.difficultyBtn');
  if (!btn) return;
  selectedDifficulty = Number(btn.dataset.value);
  document.querySelectorAll('.difficultyBtn').forEach(b => b.classList.toggle('selected', b === btn));
  vibrate(10);
});

$('#createBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:create', { name: nameValue(), difficulty: selectedDifficulty }, res => {
    if (!res?.ok) return lobbyMsg.textContent = res?.error || 'Could not create room.';
    room = res.room;
    enterGame();
    render();
  });
};

$('#joinBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:join', { code: $('#codeInput').value, name: nameValue() }, res => {
    if (!res?.ok) return lobbyMsg.textContent = res?.error || 'Could not join room.';
    room = res.room;
    enterGame();
    render();
  });
};

$('#codeInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
}

socket.on('room:update', data => {
  room = data;
  render();
});

socket.on('game:called', () => {
  vibrate([25, 35, 25]);
  renderTimer();
});

socket.on('game:found', ({ number, finderId, elapsedMs, points }) => {
  const secs = (elapsedMs / 1000).toFixed(2);
  if (finderId === myId) {
    showToast(`⚡ ${number} in ${secs}s  +${points}`);
    vibrate([30, 35, 60]); beep('good'); flash('good');
  } else {
    showToast(`${number} found in ${secs}s`);
  }
});

socket.on('game:timeout', ({ number, finderId }) => {
  if (finderId === myId) {
    showToast(`Time! ${number} was the target. −10`);
    vibrate([80, 60, 80]); beep('bad'); flash('bad');
  } else {
    showToast(`Time! ${number} wasn't found.`);
  }
});

socket.on('game:miss', ({ number, penalty }) => {
  missNumber = number;
  renderBoard();
  showToast(`Wrong number −${penalty}`);
  vibrate(60); beep('bad'); flash('bad');
  setTimeout(() => { missNumber = null; renderBoard(); }, 430);
});

socket.on('game:rematch', () => showToast('New board started'));

$('#roomCode').onclick = async () => {
  if (!room) return;
  const shareText = `Join my Number Hunt room: ${room.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Number Hunt', text: shareText, url: location.href });
    else {
      await navigator.clipboard.writeText(room.code);
      showToast('Room code copied');
    }
  } catch {
    try { await navigator.clipboard.writeText(room.code); showToast('Room code copied'); }
    catch { showToast(`Room code: ${room.code}`); }
  }
};

$('#callBtn').onclick = callNumber;
$('#numberInput').addEventListener('keydown', e => { if (e.key === 'Enter') callNumber(); });

function callNumber() {
  const number = Number($('#numberInput').value);
  gameMsg.textContent = '';
  socket.emit('game:call', { number }, res => {
    if (!res?.ok) gameMsg.textContent = res?.error || 'Could not call that number.';
    else $('#numberInput').value = '';
  });
}

$('#newBtn').onclick = () => {
  if (!room) return;
  if (confirm(`Start a fresh ${room.difficulty}-number board and reset scores?`)) {
    socket.emit('game:new', { difficulty: room.difficulty }, res => {
      if (!res?.ok) gameMsg.textContent = res?.error || 'Could not start rematch.';
    });
  }
};

function render() {
  if (!room) return;
  $('#roomCode').textContent = room.code;
  $('#roundNum').textContent = room.round;
  $('#boardSize').textContent = room.difficulty;
  $('#numberInput').max = room.difficulty;
  $('#numberInput').placeholder = `1–${room.difficulty}`;
  document.documentElement.style.setProperty('--cols', room.difficulty <= 50 ? 8 : room.difficulty <= 100 ? 10 : 12);
  renderScore();
  renderStatus();
  renderBoard();
  renderTimer();
}

function renderScore() {
  $('#scoreBar').innerHTML = room.players.map(p => {
    const avg = p.finds ? `${(p.totalFindMs / p.finds / 1000).toFixed(2)}s avg` : '— avg';
    return `<div class="playerCard ${p.id === room.currentCallerId ? 'active' : ''}">
      <div class="playerMain"><span class="playerName">${escapeHtml(p.name)} ${p.id === myId ? '<em>YOU</em>' : ''}</span><span class="playerStats">${p.finds} finds · ${avg} · ${p.wrongTaps} misses</span></div>
      <span class="score">${p.score}</span>
    </div>`;
  }).join('');
}

function renderStatus() {
  const waiting = !room.gameStarted || room.players.length < 2;
  $('#waitingControls').classList.toggle('hidden', !waiting);
  $('#callerControls').classList.add('hidden');
  $('#finderControls').classList.add('hidden');

  if (waiting) {
    $('#turnText').textContent = 'Waiting for Player 2…';
    $('#targetText').textContent = 'Share the room code';
    return;
  }

  const iAmCaller = room.currentCallerId === myId;
  const caller = room.players.find(p => p.id === room.currentCallerId);
  if (iAmCaller) {
    $('#callerControls').classList.toggle('hidden', room.target !== null);
    $('#turnText').textContent = room.target === null ? 'Your turn to call' : 'They are searching…';
    $('#targetText').textContent = room.target === null ? `Pick any uncircled number` : `You called ${room.target}`;
  } else {
    $('#finderControls').classList.remove('hidden');
    $('#turnText').textContent = room.target === null ? `${caller?.name || 'Opponent'} is choosing…` : `FIND ${room.target}`;
    $('#targetText').textContent = room.target === null ? 'Get ready' : 'Tap it before time runs out';
  }
}

function renderBoard() {
  if (!room) return;
  const found = new Set(room.found);
  board.innerHTML = '';
  room.board.forEach((n, idx) => {
    const btn = document.createElement('button');
    btn.className = 'num';
    if (found.has(n)) btn.classList.add('found');
    if (missNumber === n) btn.classList.add('miss');
    const rotation = ((idx * 17) % 17) - 8;
    const dx = ((idx * 11) % 7) - 3;
    const dy = ((idx * 13) % 7) - 3;
    btn.style.setProperty('--r', `${rotation}deg`);
    btn.style.setProperty('--dx', `${dx}px`);
    btn.style.setProperty('--dy', `${dy}px`);
    btn.textContent = n;
    btn.disabled = found.has(n);
    btn.onclick = () => onNumberTap(n);
    board.appendChild(btn);
  });
}

function onNumberTap(n) {
  if (!room || !room.gameStarted) return;
  const iAmCaller = room.currentCallerId === myId;
  if (iAmCaller && room.target === null) {
    $('#numberInput').value = n;
    vibrate(8);
    return;
  }
  if (!iAmCaller && room.target !== null) {
    gameMsg.textContent = '';
    socket.emit('game:find', { number: n }, res => {
      if (!res?.ok && res?.error !== 'Not the called number.' && res?.error !== 'Time ran out.') {
        gameMsg.textContent = res?.error || '';
      }
    });
  }
}

function renderTimer() {
  cancelAnimationFrame(rafId);
  const bar = $('#timerBar');
  const text = $('#timerText');
  const label = $('#timerLabel');

  if (!room?.target || !room.roundStartedAt) {
    bar.style.transform = 'scaleX(1)';
    text.textContent = '20.0';
    label.textContent = 'READY';
    return;
  }

  const tick = () => {
    if (!room?.target || !room.roundStartedAt) return;
    const limit = room.roundLimitMs || 20000;
    const left = Math.max(0, limit - (Date.now() - room.roundStartedAt));
    text.textContent = (left / 1000).toFixed(1);
    label.textContent = 'TIME';
    bar.style.transform = `scaleX(${left / limit})`;
    bar.classList.toggle('danger', left <= 5000);
    if (left > 0) rafId = requestAnimationFrame(tick);
  };
  tick();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
