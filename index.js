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

// ── User accounts (username -> { salt, hash, color, memberNumber }) ───────────
const accounts = new Map();
let memberCounter = 0;

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function registerUser(username, password) {
  const salt         = crypto.randomBytes(16).toString('hex');
  const hash         = hashPassword(password, salt);
  const color        = COLORS[colorIndex++ % COLORS.length];
  const memberNumber = ++memberCounter;
  accounts.set(username.toLowerCase(), { username, salt, hash, color, memberNumber });
  return { color, memberNumber };
}

function loginUser(username, password) {
  const acc = accounts.get(username.toLowerCase());
  if (!acc) return { ok: false, error: 'Username not found. Register first!' };
  const hash = hashPassword(password, acc.salt);
  if (hash !== acc.hash) return { ok: false, error: 'Wrong password.' };
  return { ok: true, color: acc.color, username: acc.username, memberNumber: acc.memberNumber };
}

// ── Friends store (username -> Set of friends, Map of pending) ────────────────
const friendships    = new Map(); // username -> Set<username>
const friendRequests = new Map(); // username -> Set<username> (pending incoming)

function getFriends(username) {
  if (!friendships.has(username)) friendships.set(username, new Set());
  return friendships.get(username);
}
function getPending(username) {
  if (!friendRequests.has(username)) friendRequests.set(username, new Set());
  return friendRequests.get(username);
}
function getSocketByUsername(username) {
  for (const [socket, info] of clients) {
    if (info.username.toLowerCase() === username.toLowerCase()) return { socket, info };
  }
  return null;
}

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
    name: c.username, color: c.color, status: 'online', memberNumber: c.memberNumber
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

    // ── REGISTER ──────────────────────────────────────────────────────────
    if (msg.type === 'register') {
      const username = (msg.username || '').slice(0, 24).trim();
      const password = (msg.password || '').trim();
      if (!username) { send(socket, { type: 'auth_error', text: 'Username cannot be empty.' }); return; }
      if (!password || password.length < 4) { send(socket, { type: 'auth_error', text: 'Password must be at least 4 characters.' }); return; }
      if (accounts.has(username.toLowerCase())) { send(socket, { type: 'auth_error', text: 'Username already taken.' }); return; }

      const { color, memberNumber } = registerUser(username, password);
      info = { id: clientId, username, color, memberNumber };
      clients.set(socket, info);

      send(socket, { type: 'auth_ok', username, color, memberNumber });
      send(socket, { type: 'history', messages });
      send(socket, { type: 'system', text: `Welcome to Rrcord, ${username}! 🎉` });
      broadcast({ type: 'system', text: `${username} just created an account!` }, socket);
      broadcastMembers();
      console.log(`[register] ${username}#${memberNumber}`);
    }

    // ── LOGIN ─────────────────────────────────────────────────────────────
    if (msg.type === 'login') {
      const username = (msg.username || '').slice(0, 24).trim();
      const password = (msg.password || '').trim();
      const result = loginUser(username, password);
      if (!result.ok) { send(socket, { type: 'auth_error', text: result.error }); return; }

      info = { id: clientId, username: result.username, color: result.color, memberNumber: result.memberNumber };
      clients.set(socket, info);

      send(socket, { type: 'auth_ok', username: result.username, color: result.color, memberNumber: result.memberNumber });
      send(socket, { type: 'history', messages });
      send(socket, { type: 'system', text: `Welcome back, ${result.username}!` });
      broadcast({ type: 'system', text: `${result.username} joined the server.` }, socket);
      broadcastMembers();
      console.log(`[login] ${result.username}#${result.memberNumber}`);
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

    // ── FRIEND REQUEST ────────────────────────────────────────────────────
    if (msg.type === 'friend_request' && info) {
      const to = (msg.to || '').trim();
      const acc = accounts.get(to.toLowerCase());
      if (!acc) { send(socket, { type: 'friend_request_sent', ok: false, text: `User "${to}" not found.` }); return; }
      if (to.toLowerCase() === info.username.toLowerCase()) { send(socket, { type: 'friend_request_sent', ok: false, text: "You can't friend yourself!" }); return; }
      if (getFriends(info.username).has(acc.username)) { send(socket, { type: 'friend_request_sent', ok: false, text: `You're already friends with ${acc.username}.` }); return; }
      if (getPending(acc.username).has(info.username)) { send(socket, { type: 'friend_request_sent', ok: false, text: `Request already sent to ${acc.username}.` }); return; }

      getPending(acc.username).add(info.username);
      send(socket, { type: 'friend_request_sent', ok: true, text: `Friend request sent to ${acc.username}!`, to: acc.username });

      const target = getSocketByUsername(acc.username);
      if (target) {
        send(target.socket, { type: 'friend_request_received', from: info.username, color: info.color, memberNumber: info.memberNumber });
      }
    }

    // ── FRIEND RESPONSE ───────────────────────────────────────────────────
    if (msg.type === 'friend_response' && info) {
      const from = msg.from;
      const accept = msg.accept;
      getPending(info.username).delete(from);

      const fromAcc = accounts.get(from.toLowerCase());
      if (!fromAcc) return;

      if (accept) {
        getFriends(info.username).add(fromAcc.username);
        getFriends(fromAcc.username).add(info.username);

        send(socket, { type: 'friend_you_accepted', username: fromAcc.username, color: fromAcc.color, memberNumber: fromAcc.memberNumber });

        const target = getSocketByUsername(from);
        if (target) {
          send(target.socket, { type: 'friend_accepted', username: info.username, color: info.color, memberNumber: info.memberNumber });
        }
      } else {
        send(socket, { type: 'friend_request_declined', username: fromAcc.username });
        const target = getSocketByUsername(from);
        if (target) {
          send(target.socket, { type: 'friend_declined', username: info.username });
        }
      }
    }

    // ── FRIEND CANCEL ─────────────────────────────────────────────────────
    if (msg.type === 'friend_cancel' && info) {
      const toAcc = accounts.get((msg.to || '').toLowerCase());
      if (toAcc) getPending(toAcc.username).delete(info.username);
    }

    // ── FRIEND REMOVE ─────────────────────────────────────────────────────
    if (msg.type === 'friend_remove' && info) {
      const toAcc = accounts.get((msg.username || '').toLowerCase());
      if (toAcc) {
        getFriends(info.username).delete(toAcc.username);
        getFriends(toAcc.username).delete(info.username);
        const target = getSocketByUsername(toAcc.username);
        if (target) send(target.socket, { type: 'friend_removed', username: info.username });
      }
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
