/**
 * Rrcord Server — zero dependencies, pure Node.js
 * Run: node server.js
 * Then open http://localhost:3000 — or share your ngrok URL!
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── In-memory store ───────────────────────────────────────────────────────────
const messages = {
  gen:   [],
  intro: [],
  dev:   [],
  memes: [],
};

const clients = new Map(); // ws -> { id, username, color }

const COLORS = ['#5b6af0','#3ddc84','#e05c5c','#f0a843','#b06ef0','#5eb0f0','#f06b9a','#4ecdc4'];
let colorIndex = 0;

// ── WebSocket handshake (RFC 6455) ────────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

// ── WebSocket frame parser ────────────────────────────────────────────────────
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  if (opcode === 0x8) return { type: 'close' };
  if (opcode !== 0x1) return null; // only text frames

  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (buf.length < offset + (masked ? 4 : 0) + payloadLen) return null;

  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + payloadLen);
  }
  return { type: 'text', data: payload.toString('utf8') };
}

// ── WebSocket frame builder ───────────────────────────────────────────────────
function buildFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function send(socket, obj) {
  try { socket.write(buildFrame(JSON.stringify(obj))); } catch (_) {}
}

function broadcast(obj, excludeSocket = null) {
  const frame = buildFrame(JSON.stringify(obj));
  for (const [socket] of clients) {
    if (socket !== excludeSocket) {
      try { socket.write(frame); } catch (_) {}
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

// ── HTTP + WS server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve rrcord.html for any GET request to /
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'rrcord.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('rrcord.html not found — make sure it is in the same folder as server.js');
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

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') { socket.destroy(); return; }

  wsHandshake(req, socket);

  const clientId = crypto.randomUUID();
  let buf = Buffer.alloc(0);
  let info = null;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = parseFrame(buf)) !== null) {
      // advance buffer (simple: reset after successful parse for typical messages)
      buf = Buffer.alloc(0);

      if (frame.type === 'close') { socket.destroy(); return; }

      let msg;
      try { msg = JSON.parse(frame.data); } catch { continue; }

      // ── JOIN ──────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const username = (msg.username || 'User').slice(0, 24).trim() || 'User';
        const color = COLORS[colorIndex++ % COLORS.length];
        info = { id: clientId, username, color };
        clients.set(socket, info);

        // send history for all channels
        send(socket, { type: 'history', messages });

        // welcome
        send(socket, { type: 'system', text: `Welcome to Rrcord, ${username}!` });

        // announce join
        broadcast({ type: 'system', text: `${username} joined the server.` }, socket);

        broadcastMembers();
        console.log(`[+] ${username} connected (${clients.size} online)`);
      }

      // ── CHAT MESSAGE ──────────────────────────────────────────────────────
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
        // keep last 200 messages per channel
        if (messages[channel].length > 200) messages[channel].shift();

        broadcastAll({ type: 'message', message: entry });
        console.log(`[${channel}] ${info.username}: ${entry.text}`);
      }

      // ── REACTION ──────────────────────────────────────────────────────────
      if (msg.type === 'reaction' && info) {
        broadcastAll({ type: 'reaction', messageId: msg.messageId, emoji: msg.emoji, username: info.username });
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

  socket.on('error', () => {
    clients.delete(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Rrcord server running!`);
  console.log(`   Open in browser: http://localhost:${PORT}`);
  console.log(`   Local network:   http://<your-local-ip>:${PORT}`);
  console.log(`   With ngrok:      ngrok http ${PORT}  →  share the https URL`);
  console.log(`\n   Both server.js and rrcord.html must be in the same folder.\n`);
});
