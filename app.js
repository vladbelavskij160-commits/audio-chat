'use strict';

// Адрес сервера сигналинга. По умолчанию это тот же хост, откуда открыта страница.
// Если страница лежит на статическом хостинге, а server.js запущен отдельно:
// const WS_URL = 'wss://ваш-сервер.example';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
// STUN помогает найти путь между пользователями. Для части сетей понадобится ещё TURN-сервер.
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // Сюда вставьте данные TURN-сервера, когда он у вас появится, например:
    // { urls: 'turn:адрес-сервера:80', username: 'логин', credential: 'пароль' },
  ],
};

const $ = id => document.getElementById(id);

let ws = null, wsReady = null;           // WebSocket к серверу
let pc = null;                           // RTCPeerConnection с текущим собеседником
let mic = null, camStream = null;        // свой микрофон и камера
let ctx = null, micA = null, peerA = null; // анализаторы громкости: {an, buf}
let connected = false, muted = false;
let callTimer = null, callStart = 0;
let level = 0, peerLevel = 0;

const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const wsSend = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

function setStatus(text, online = false) {
  $('statusText').textContent = text;
  $('status').classList.toggle('on', online);
}
function say(text, who = 'sys') {
  const li = document.createElement('li');
  li.className = 'msg ' + who;
  li.textContent = text;
  $('messages').append(li);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function setChat(on) { ['msgInput', 'sendBtn'].forEach(id => $(id).disabled = !on); }
function setActive(active) {
  ['nextBtn', 'stopBtn', 'muteBtn'].forEach(id => $(id).disabled = !active);
  $('startBtn').disabled = active;
}

/* ---------- Подключение к серверу ---------- */
// Сокет открыт всё время, пока страница открыта: так виден счётчик «На сайте» и быстрый поиск.
function ensureWS() {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve, reject) => {
    const s = new WebSocket(WS_URL);
    ws = s;
    s.onopen = () => resolve();
    s.onerror = () => reject(new Error('ws'));
    s.onmessage = e => onServer(JSON.parse(e.data));
    s.onclose = () => {
      ws = null; wsReady = null;
      $('online').textContent = '';
      if (mic) { say('Связь с сервером потеряна.'); stop(false); }
      setTimeout(() => ensureWS().catch(() => {}), 3000);   // переподключение
    };
  });
  return wsReady;
}

// Сообщения от сервера
function onServer(m) {
  if (m.type === 'online') $('online').textContent = 'На сайте: ' + m.n;
  else if (m.type === 'matched') startPeer(m.initiator);
  else if (m.type === 'signal') handleSignal(m.data);
  else if (m.type === 'chat') say(m.text, 'peer');
  else if (m.type === 'peer-left') { say('Собеседник вышел. Ищем следующего…'); find(); }
}

/* ---------- Старт: микрофон, сервер, поиск ---------- */
async function start() {
  if (!navigator.mediaDevices?.getUserMedia) { say('Микрофон недоступен: нужен HTTPS или localhost.'); return; }
  try { await ensureWS(); } catch { say('Сервер недоступен. Проверьте, что server.js запущен.'); return; }
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    say('Нет доступа к микрофону (' + e.name + '). Разрешите его в настройках браузера.');
    return;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  micA = makeAnalyser(mic);
  muted = false; applyMute();
  setActive(true);
  find();
}

function makeAnalyser(stream) {
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  return { an, buf: new Uint8Array(an.fftSize) };
}

function find() {
  closePeer();
  $('messages').innerHTML = '';
  setChat(false);
  setStatus('Ищем подходящего собеседника…');
  wsSend({ type: 'find', prefs: { me: $('me').value, myAge: $('myAge').value, who: $('who').value, age: $('age').value } });
}

function stop(notify = true) {
  if (notify) wsSend({ type: 'leave' });
  closePeer();
  mic?.getTracks().forEach(t => t.stop()); mic = null;
  ctx?.close(); ctx = micA = null;
  setChat(false); setActive(false); setStatus('Не в сети');
}

/* ---------- WebRTC: голос между двумя людьми ---------- */
function startPeer(initiator) {
  if (!mic) return;
  pc = new RTCPeerConnection(ICE);
  mic.getTracks().forEach(t => pc.addTrack(t, mic));
  pc.onicecandidate = e => e.candidate && wsSend({ type: 'signal', data: { candidate: e.candidate } });
  pc.ontrack = e => {                                    // пришёл голос собеседника
    $('remoteAudio').srcObject = e.streams[0];
    peerA = makeAnalyser(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'connected') onConnected();
    if (pc?.connectionState === 'failed') { say('Соединение не удалось (возможно, нужен TURN-сервер). Ищем другого…'); find(); }
  };
  setStatus('Соединяем…');
  const thisPc = pc;                                     // если за 15 секунд связь не поднялась, сообщаем
  setTimeout(() => {
    if (pc === thisPc && pc.connectionState !== 'connected') {
      say('Прямое соединение не устанавливается. Скорее всего, нужен TURN-сервер.');
      console.log('ICE state:', pc.iceConnectionState, pc.connectionState);
    }
  }, 15000);
  if (initiator) {                                       // первый в паре отправляет offer
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => wsSend({ type: 'signal', data: { sdp: pc.localDescription } }));
  }
}

async function handleSignal(d) {
  if (!pc) return;
  try {
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') {                      // второй отвечает answer
        await pc.setLocalDescription(await pc.createAnswer());
        wsSend({ type: 'signal', data: { sdp: pc.localDescription } });
      }
    } else if (d.candidate) {
      await pc.addIceCandidate(d.candidate);
    }
  } catch (e) { console.warn('signal error', e); }
}

function onConnected() {
  if (connected) return;
  connected = true;
  callStart = Date.now();
  $('timer').hidden = false;
  callTimer = setInterval(() => $('timer').textContent = fmt((Date.now() - callStart) / 1000), 500);
  setStatus('В эфире', true);
  setChat(true);
  say('Собеседник на связи. Говорите или пишите.');
}

function closePeer() {
  pc?.close(); pc = null;
  $('remoteAudio').srcObject = null;
  peerA = null; connected = false;
  clearInterval(callTimer);
  $('timer').hidden = true;
}

/* ---------- Микрофон: отключить звук без остановки потока ---------- */
function applyMute() {
  mic?.getAudioTracks().forEach(t => t.enabled = !muted);
  $('muteBtn').textContent = 'Микрофон: ' + (muted ? 'выкл' : 'вкл');
  $('muteBtn').classList.toggle('off', muted);
  $('muteBtn').setAttribute('aria-pressed', muted);
}

/* ---------- Своя камера: включается и выключается отдельно ---------- */
async function toggleCam() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
    $('camVideo').srcObject = null;
    $('pip').hidden = true;
  } else {
    if (!navigator.mediaDevices?.getUserMedia) { say('Камера недоступна: нужен HTTPS или localhost.'); return; }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    } catch (e) { say('Нет доступа к камере (' + e.name + ').'); return; }
    $('camVideo').srcObject = camStream;
    $('pip').hidden = false;
  }
  const on = !!camStream;
  $('camBtn').textContent = 'Камера: ' + (on ? 'вкл' : 'выкл');
  $('camBtn').classList.toggle('on', on);
  $('camBtn').setAttribute('aria-pressed', on);
}

/* ---------- Текстовый чат ---------- */
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text || !connected) return;
  $('msgInput').value = '';
  say(text, 'me');
  wsSend({ type: 'chat', text });
});

/* ---------- Визуализация: две «капли» по реальной громкости ---------- */
const cv = $('viz'), g = cv.getContext('2d');
function resize() {
  const r = devicePixelRatio || 1;
  cv.width = cv.clientWidth * r; cv.height = cv.clientHeight * r;
  g.setTransform(r, 0, 0, r, 0, 0);
}
addEventListener('resize', resize); resize();

function levelOf(a) {                       // громкость 0..1 (RMS)
  if (!a) return 0;
  a.an.getByteTimeDomainData(a.buf);
  let s = 0;
  for (const v of a.buf) { const d = (v - 128) / 128; s += d * d; }
  return Math.min(1, Math.sqrt(s / a.buf.length) * 5);
}
function orb(x, y, base, lv, color) {
  const r = base + lv * base * .9;
  const grad = g.createRadialGradient(x, y, r * .1, x, y, r * 1.6);
  grad.addColorStop(0, color); grad.addColorStop(.55, color + '55'); grad.addColorStop(1, color + '00');
  g.fillStyle = grad; g.beginPath(); g.arc(x, y, r * 1.6, 0, 7); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(x, y, base * .8 + lv * base * .35, 0, 7); g.fill();
}
function draw() {
  const w = cv.clientWidth, h = cv.clientHeight, base = Math.min(w / 6, h / 4, 70);
  g.clearRect(0, 0, w, h);
  level += ((muted ? 0 : levelOf(micA)) - level) * .25;
  peerLevel += (levelOf(peerA) - peerLevel) * .25;
  if (connected) {
    g.strokeStyle = '#4fd1c555'; g.setLineDash([4, 8]); g.beginPath();
    g.moveTo(w * .25 + base, h / 2 - 10); g.lineTo(w * .75 - base, h / 2 - 10); g.stroke(); g.setLineDash([]);
  }
  orb(w * .25, h / 2 - 10, base, level, '#ffb454');
  orb(w * .75, h / 2 - 10, base, connected ? peerLevel : 0, connected ? '#4fd1c5' : '#3a4263');
  requestAnimationFrame(draw);
}
draw();

/* ---------- События ---------- */
$('startBtn').addEventListener('click', start);
$('nextBtn').addEventListener('click', find);
$('stopBtn').addEventListener('click', () => stop());
$('muteBtn').addEventListener('click', () => { muted = !muted; applyMute(); });
$('camBtn').addEventListener('click', toggleCam);
// Сменили условия во время поиска или разговора: начинаем поиск заново по новым условиям
['me', 'myAge', 'who', 'age'].forEach(id => $(id).addEventListener('change', () => { if (mic) find(); }));
ensureWS().catch(() => {});
