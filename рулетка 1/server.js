'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

/* ---------- Раздача статических файлов ---------- */
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const name = FILES[req.url.split('?')[0]];
  if (!name) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] });
    res.end(data);
  });
});

/* ---------- Подбор пар и сигналинг ---------- */
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
let waiting = []; // очередь ожидающих собеседника

// Допустимые значения (всё остальное отбрасываем)
const GENDERS = ['m', 'f'], WANT = ['any', 'm', 'f'], AGES = ['18-24', '25-34', '35+'], WANT_AGES = ['any', ...AGES];
const pick = (v, list, def) => (list.includes(v) ? v : def);

// a подходит под условия поиска b, и наоборот: пара собирается только при взаимном совпадении
const accepts = (a, b) => (a.want === 'any' || a.want === b.me) && (a.wantAge === 'any' || a.wantAge === b.myAge);
const compatible = (a, b) => accepts(a, b) && accepts(b, a);

const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

// Сколько людей сейчас на сайте
function broadcastOnline() {
  const n = wss.clients.size;
  wss.clients.forEach(c => send(c, { type: 'online', n }));
}

// Разрываем пару (или убираем из очереди) и уведомляем собеседника
function unpair(ws) {
  waiting = waiting.filter(w => w !== ws);
  const p = ws.peer;
  if (p) { ws.peer = null; p.peer = null; send(p, { type: 'peer-left' }); }
}

// Ищем среди ожидающих того, кто подходит обоим, иначе встаём в очередь
function find(ws, prefs = {}) {
  unpair(ws);
  ws.me = pick(prefs.me, GENDERS, 'm');
  ws.myAge = pick(prefs.myAge, AGES, '18-24');
  ws.want = pick(prefs.who, WANT, 'any');
  ws.wantAge = pick(prefs.age, WANT_AGES, 'any');
  const i = waiting.findIndex(o => o.readyState === 1 && compatible(ws, o));
  if (i >= 0) {
    const a = waiting.splice(i, 1)[0];
    a.peer = ws; ws.peer = a;
    send(a, { type: 'matched', initiator: true });   // a создаёт offer
    send(ws, { type: 'matched', initiator: false });
  } else {
    waiting.push(ws);
  }
}

wss.on('connection', ws => {
  ws.peer = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'find') find(ws, m.prefs);
    else if (m.type === 'leave') unpair(ws);
    else if (ws.peer && m.type === 'signal') send(ws.peer, { type: 'signal', data: m.data }); // offer / answer / ICE
    else if (ws.peer && m.type === 'chat' && typeof m.text === 'string') send(ws.peer, { type: 'chat', text: m.text.slice(0, 500) });
  });
  ws.on('close', () => { unpair(ws); broadcastOnline(); });
  broadcastOnline();
});

// Отключаем «мёртвые» соединения
setInterval(() => wss.clients.forEach(ws => {
  if (!ws.alive) return ws.terminate();
  ws.alive = false; ws.ping();
}), 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Запущено: http://localhost:' + PORT));
