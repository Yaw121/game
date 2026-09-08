const socket = io();
let room = null;
let myId = null;
let missNumber = null;

const $ = (s) => document.querySelector(s);
const lobby = $('#lobby');
const game = $('#game');
const board = $('#board');
const lobbyMsg = $('#lobbyMsg');
const gameMsg = $('#gameMsg');

socket.on('connect', () => { myId = socket.id; });

function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

function nameValue() {
  return ($('#nameInput').value.trim() || 'Player').slice(0, 18);
}

$('#createBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:create', { name: nameValue() }, (res) => {
    if (!res.ok) return lobbyMsg.textContent = res.error;
    room = res.room;
    enterGame(); render();
  });
};

$('#joinBtn').onclick = () => {
  lobbyMsg.textContent = '';
  socket.emit('room:join', { code: $('#codeInput').value, name: nameValue() }, (res) => {
    if (!res.ok) return lobbyMsg.textContent = res.error;
    room = res.room;
    enterGame(); render();
  });
};

$('#codeInput').addEventListener('input', e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));

function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
}

socket.on('room:update', (data) => {
  room = data;
  render();
});

socket.on('game:found', ({ number, finderId }) => {
  showToast(finderId === myId ? `Nice! You found ${number}.` : `${number} was found.`);
});

socket.on('game:miss', ({ number }) => {
  missNumber = number;
  renderBoard();
  setTimeout(() => { missNumber = null; renderBoard(); }, 420);
});

$('#roomCode').onclick = async () => {
  if (!room) return;
  try { await navigator.clipboard.writeText(room.code); showToast('Room code copied'); }
  catch { showToast(`Room code: ${room.code}`); }
};

$('#callBtn').onclick = callNumber;
$('#numberInput').addEventListener('keydown', e => { if (e.key === 'Enter') callNumber(); });
function callNumber() {
  const number = Number($('#numberInput').value);
  gameMsg.textContent = '';
  socket.emit('game:call', { number }, (res) => {
    if (!res?.ok) gameMsg.textContent = res?.error || 'Could not call that number.';
    else $('#numberInput').value = '';
  });
}

$('#newBtn').onclick = () => {
  if (confirm('Start a fresh board and reset both scores?')) socket.emit('game:new');
};

function render() {
  if (!room) return;
  $('#roomCode').textContent = room.code;
  renderScore();
  renderStatus();
  renderBoard();
}

function renderScore() {
  $('#scoreBar').innerHTML = room.players.map(p => `
    <div class="playerCard ${p.id === room.currentCallerId ? 'active' : ''}">
      <span>${escapeHtml(p.name)} ${p.id === myId ? '(you)' : ''}</span>
      <span class="score">${p.score}</span>
    </div>`).join('');
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

  if (room.winner) {
    $('#turnText').textContent = `${room.winner} wins!`;
    $('#targetText').textContent = 'Start a new game to play again.';
    return;
  }

  const iAmCaller = room.currentCallerId === myId;
  const caller = room.players.find(p => p.id === room.currentCallerId);

  if (iAmCaller) {
    $('#callerControls').classList.toggle('hidden', room.target !== null);
    $('#turnText').textContent = room.target === null ? 'Your turn to call' : 'They are searching…';
    $('#targetText').textContent = room.target === null ? `Round ${room.round}` : `You called ${room.target}`;
  } else {
    $('#finderControls').classList.remove('hidden');
    $('#turnText').textContent = room.target === null ? `${caller?.name || 'Opponent'} is choosing…` : `Find ${room.target}`;
    $('#targetText').textContent = room.target === null ? 'Get ready' : 'Tap it as soon as you spot it';
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
    const rotation = ((idx * 17) % 15) - 7;
    btn.style.setProperty('--r', `${rotation}deg`);
    btn.textContent = n;
    btn.disabled = found.has(n);
    btn.onclick = () => onNumberTap(n);
    board.appendChild(btn);
  });
}

function onNumberTap(n) {
  if (!room || !room.gameStarted || room.winner) return;
  const iAmCaller = room.currentCallerId === myId;
  if (iAmCaller && room.target === null) {
    $('#numberInput').value = n;
    return;
  }
  if (!iAmCaller && room.target !== null) {
    gameMsg.textContent = '';
    socket.emit('game:find', { number: n }, (res) => {
      if (!res?.ok && res?.error !== 'Not the called number.') gameMsg.textContent = res?.error || '';
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
