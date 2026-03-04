/**
 * Rrcord Server — uses 'ws' npm package
 * Run: npm install && node index.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── In-memory store ───────────────────────────────────────────────────────────
const messages = {
  gen:   [],
  intro: [],
  dev:   [],
  memes: [],
};

const clients = new Map();

const COLORS = ['#5b6af0','#3ddc84','#e05c5c','#f0a843','#b06ef0','#5eb0f0','#f06b9a','#4ecdc4'];
let colorIndex = 0;

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function send(socket, obj) {
  try { socket.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(obj, excludeSocket = null) {
  const data = JSON.stringify(obj);
  for (const [socket] of clients) {
    if (socket !== excludeSocket && socket.readyState === 1) {
      try { socket.send(data); } catch (_) {}
    }
  }
}

function broadcastAll(obj) { broadcast(obj, null); }

function broadcastMembers() {
  const list = [...clients.values()].map(c => ({
    name: c.username, color: c.color, status: 'online'
  }));
  broadcastAll({ type: 'members', members: list });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'rrcord.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('rrcord.html not found — make sure it is in the same folder as index.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const clientId = crypto.randomUUID();
  let info = null;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      const username = (msg.username || 'User').slice(0, 24).trim() || 'User';
      const color = COLORS[colorIndex++ % COLORS.length];
      info = { id: clientId, username, color };
      clients.set(socket, info);

      send(socket, { type: 'history', messages });
      send(socket, { type: 'system', text: `Welcome to Rrcord, ${username}!` });
      broadcast({ type: 'system', text: `${username} joined the server.` }, socket);
      broadcastMembers();
      console.log(`[+] ${username} connected (${clients.size} online)`);
    }

    if (msg.type === 'message' && info) {
      const channel = msg.channel || 'gen';
      if (!messages[channel]) messages[channel] = [];

      const now = new Date();
      const time = `Today at ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;

      const entry = {
        id: crypto.randomUUID(),
        author: info.username,
        color: info.color,
        text: msg.text.slice(0, 2000),
        channel,
        time,
        ts: Date.now(),
      };

      messages[channel].push(entry);
      if (messages[channel].length > 200) messages[channel].shift();

      broadcastAll({ type: 'message', message: entry });
      console.log(`[${channel}] ${info.username}: ${entry.text}`);
    }

    if (msg.type === 'reaction' && info) {
      broadcastAll({ type: 'reaction', messageId: msg.messageId, emoji: msg.emoji, username: info.username });
    }
  });

  socket.on('close', () => {
    const c = clients.get(socket);
    if (c) {
      clients.delete(socket);
      broadcast({ type: 'system', text: `${c.username} left the server.` });
      broadcastMembers();
      console.log(`[-] ${c.username} disconnected (${clients.size} online)`);
    }
  });

  socket.on('error', () => { clients.delete(socket); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Rrcord server running!`);
  console.log(`   Open in browser: http://localhost:${PORT}\n`);
});
