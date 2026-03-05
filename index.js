const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Persistence ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return raw;
    }
  } catch(e) { console.error('Failed to load data:', e); }
  return { accounts: {}, friendships: {}, dmMessages: {}, messages: { gen:[], intro:[], dev:[], memes:[] }, memberCounter: 0 };
}

function saveData() {
  try {
    const out = {
      memberCounter,
      accounts:    Object.fromEntries(accounts),
      friendships: Object.fromEntries([...friendships].map(([k,v]) => [k, [...v]])),
      dmMessages:  Object.fromEntries(dmMessages),
      messages,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(out));
  } catch(e) { console.error('Failed to save data:', e); }
}

const saved = loadData();
let memberCounter = saved.memberCounter || 0;

// accounts
const accounts = new Map(Object.entries(saved.accounts || {}));

// friendships
const friendships = new Map(
  Object.entries(saved.friendships || {}).map(([k,v]) => [k, new Set(v)])
);

// friend requests (in-memory only, not persisted)
const friendRequests = new Map();

// dm messages
const dmMessages = new Map(Object.entries(saved.dmMessages || {}));

// channel messages
const messages = saved.messages || { gen:[], intro:[], dev:[], memes:[] };

const COLORS = ['#5b6af0','#3ddc84','#e05c5c','#f0a843','#b06ef0','#5eb0f0','#f06b9a','#4ecdc4'];
let colorIndex = 0;

const clients = new Map();
const voiceRooms = new Map(); // channelId -> Set<username>

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}
function registerUser(username, password) {
  const salt         = crypto.randomBytes(16).toString('hex');
  const hash         = hashPassword(password, salt);
  const color        = COLORS[colorIndex++ % COLORS.length];
  const memberNumber = ++memberCounter;
  accounts.set(username.toLowerCase(), { username, salt, hash, color, memberNumber });
  saveData();
  return { color, memberNumber };
}
function loginUser(username, password) {
  const acc = accounts.get(username.toLowerCase());
  if (!acc) return { ok: false, error: 'Username not found. Register first!' };
  if (hashPassword(password, acc.salt) !== acc.hash) return { ok: false, error: 'Wrong password.' };
  return { ok: true, ...acc };
}
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
function dmKey(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join('::'); }
function getDMs(a, b) {
  const key = dmKey(a, b);
  if (!dmMessages.has(key)) dmMessages.set(key, []);
  return dmMessages.get(key);
}
function send(socket, obj) { try { socket.send(JSON.stringify(obj)); } catch(_) {} }
function broadcast(obj, excludeSocket = null) {
  const data = JSON.stringify(obj);
  for (const [s] of clients) {
    if (s !== excludeSocket && s.readyState === 1) try { s.send(data); } catch(_) {}
  }
}
function broadcastAll(obj) { broadcast(obj, null); }
function broadcastMembers() {
  broadcastAll({ type: 'members', members: [...clients.values()].map(c => ({
    name: c.username, color: c.color, status: 'online', memberNumber: c.memberNumber
  }))});
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'rrcord.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('rrcord.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  const clientId = crypto.randomUUID();
  let info = null;

  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    // REGISTER
    if (msg.type === 'register') {
      const username = (msg.username || '').slice(0,24).trim();
      const password = (msg.password || '').trim();
      if (!username)              { send(socket, { type:'auth_error', text:'Username cannot be empty.' }); return; }
      if (password.length < 4)   { send(socket, { type:'auth_error', text:'Password must be at least 4 characters.' }); return; }
      if (accounts.has(username.toLowerCase())) { send(socket, { type:'auth_error', text:'Username already taken.' }); return; }
      const { color, memberNumber } = registerUser(username, password);
      info = { id: clientId, username, color, memberNumber };
      clients.set(socket, info);
      // send existing friends list from persistence
      const friendList = [...getFriends(username)].map(f => {
        const acc = accounts.get(f.toLowerCase());
        return acc ? { username: acc.username, color: acc.color, memberNumber: acc.memberNumber } : null;
      }).filter(Boolean);
      send(socket, { type:'auth_ok', username, color, memberNumber, friends: friendList });
      send(socket, { type:'history', messages });
      send(socket, { type:'system', text:`Welcome to Rrcord, ${username}! 🎉` });
      broadcast({ type:'system', text:`${username} just created an account!` }, socket);
      broadcastMembers();
    }

    // LOGIN
    if (msg.type === 'login') {
      const username = (msg.username || '').slice(0,24).trim();
      const password = (msg.password || '').trim();
      const result = loginUser(username, password);
      if (!result.ok) { send(socket, { type:'auth_error', text: result.error }); return; }
      info = { id: clientId, username: result.username, color: result.color, memberNumber: result.memberNumber };
      clients.set(socket, info);
      // send existing friends list from persistence
      const friendList = [...getFriends(result.username)].map(f => {
        const acc = accounts.get(f.toLowerCase());
        return acc ? { username: acc.username, color: acc.color, memberNumber: acc.memberNumber } : null;
      }).filter(Boolean);
      send(socket, { type:'auth_ok', username: result.username, color: result.color, memberNumber: result.memberNumber, friends: friendList });
      send(socket, { type:'history', messages });
      send(socket, { type:'system', text:`Welcome back, ${result.username}!` });
      broadcast({ type:'system', text:`${result.username} joined the server.` }, socket);
      broadcastMembers();
    }

    // CHAT MESSAGE
    if (msg.type === 'message' && info) {
      const channel = msg.channel || 'gen';
      if (!messages[channel]) messages[channel] = [];
      const now = new Date();
      const entry = {
        id: crypto.randomUUID(), author: info.username, color: info.color,
        text: msg.text.slice(0,2000), channel,
        time: `Today at ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`,
        ts: Date.now(),
      };
      messages[channel].push(entry);
      if (messages[channel].length > 200) messages[channel].shift();
      saveData();
      broadcastAll({ type:'message', message: entry });
    }

    // DM
    if (msg.type === 'dm' && info) {
      const toAcc = accounts.get((msg.to || '').toLowerCase());
      if (!toAcc) { send(socket, { type:'dm_error', text:`User "${msg.to}" not found.` }); return; }
      // check friendship both ways
      const areFriends = getFriends(info.username).has(toAcc.username) || getFriends(toAcc.username).has(info.username);
      if (!areFriends) { send(socket, { type:'dm_error', text:`You can only DM friends.` }); return; }
      const now = new Date();
      const entry = {
        id: crypto.randomUUID(), author: info.username, color: info.color,
        to: toAcc.username, text: msg.text.slice(0,2000),
        time: `Today at ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`,
        ts: Date.now(),
      };
      getDMs(info.username, toAcc.username).push(entry);
      if (getDMs(info.username, toAcc.username).length > 200) getDMs(info.username, toAcc.username).shift();
      saveData();
      send(socket, { type:'dm_message', message: entry });
      const target = getSocketByUsername(toAcc.username);
      if (target) send(target.socket, { type:'dm_message', message: entry });
    }

    // DM HISTORY
    if (msg.type === 'dm_history' && info) {
      const toAcc = accounts.get((msg.with || '').toLowerCase());
      if (!toAcc) return;
      send(socket, { type:'dm_history', with: toAcc.username, messages: getDMs(info.username, toAcc.username) });
    }

    // FRIEND REQUEST
    if (msg.type === 'friend_request' && info) {
      const to = (msg.to || '').trim();
      const acc = accounts.get(to.toLowerCase());
      if (!acc) { send(socket, { type:'friend_request_sent', ok:false, text:`User "${to}" not found.` }); return; }
      if (to.toLowerCase() === info.username.toLowerCase()) { send(socket, { type:'friend_request_sent', ok:false, text:"You can't friend yourself!" }); return; }
      if (getFriends(info.username).has(acc.username)) { send(socket, { type:'friend_request_sent', ok:false, text:`Already friends with ${acc.username}.` }); return; }
      if (getPending(acc.username).has(info.username)) { send(socket, { type:'friend_request_sent', ok:false, text:`Request already sent to ${acc.username}.` }); return; }
      getPending(acc.username).add(info.username);
      send(socket, { type:'friend_request_sent', ok:true, text:`Friend request sent to ${acc.username}!`, to: acc.username });
      const target = getSocketByUsername(acc.username);
      if (target) send(target.socket, { type:'friend_request_received', from: info.username, color: info.color, memberNumber: info.memberNumber });
    }

    // FRIEND RESPONSE
    if (msg.type === 'friend_response' && info) {
      getPending(info.username).delete(msg.from);
      const fromAcc = accounts.get((msg.from || '').toLowerCase());
      if (!fromAcc) return;
      if (msg.accept) {
        getFriends(info.username).add(fromAcc.username);
        getFriends(fromAcc.username).add(info.username);
        saveData();
        send(socket, { type:'friend_you_accepted', username: fromAcc.username, color: fromAcc.color, memberNumber: fromAcc.memberNumber });
        const target = getSocketByUsername(fromAcc.username);
        if (target) send(target.socket, { type:'friend_accepted', username: info.username, color: info.color, memberNumber: info.memberNumber });
      } else {
        send(socket, { type:'friend_request_declined', username: fromAcc.username });
        const target = getSocketByUsername(fromAcc.username);
        if (target) send(target.socket, { type:'friend_declined', username: info.username });
      }
    }

    // FRIEND CANCEL
    if (msg.type === 'friend_cancel' && info) {
      const toAcc = accounts.get((msg.to || '').toLowerCase());
      if (toAcc) getPending(toAcc.username).delete(info.username);
    }

    // FRIEND REMOVE
    if (msg.type === 'friend_remove' && info) {
      const toAcc = accounts.get((msg.username || '').toLowerCase());
      if (toAcc) {
        getFriends(info.username).delete(toAcc.username);
        getFriends(toAcc.username).delete(info.username);
        saveData();
        const target = getSocketByUsername(toAcc.username);
        if (target) send(target.socket, { type:'friend_removed', username: info.username });
      }
    }

    // REACTION
    if (msg.type === 'reaction' && info) {
      broadcastAll({ type:'reaction', messageId: msg.messageId, emoji: msg.emoji, username: info.username });
    }

    // VOICE JOIN
    if (msg.type === 'voice_join' && info) {
      const channel = msg.channel;
      if (!voiceRooms.has(channel)) voiceRooms.set(channel, new Set());
      voiceRooms.get(channel).add(info.username);
      // tell joiner who's already there
      send(socket, { type: 'voice_joined', channel, members: [...voiceRooms.get(channel)] });
      // tell everyone else
      for (const [s, c] of clients) {
        if (s !== socket && voiceRooms.get(channel).has(c.username)) {
          send(s, { type: 'voice_member_joined', channel, username: info.username });
        }
      }
    }

    // VOICE LEAVE
    if (msg.type === 'voice_leave' && info) {
      const channel = msg.channel;
      if (voiceRooms.has(channel)) {
        voiceRooms.get(channel).delete(info.username);
        for (const [s, c] of clients) {
          if (s !== socket && voiceRooms.get(channel).has(c.username)) {
            send(s, { type: 'voice_member_left', channel, username: info.username });
          }
        }
      }
    }

    // VOICE OFFER
    if (msg.type === 'voice_offer' && info) {
      const target = getSocketByUsername(msg.to);
      if (target) send(target.socket, { type: 'voice_offer', from: info.username, sdp: msg.sdp });
    }

    // VOICE ANSWER
    if (msg.type === 'voice_answer' && info) {
      const target = getSocketByUsername(msg.to);
      if (target) send(target.socket, { type: 'voice_answer', from: info.username, sdp: msg.sdp });
    }

    // VOICE ICE
    if (msg.type === 'voice_ice' && info) {
      const target = getSocketByUsername(msg.to);
      if (target) send(target.socket, { type: 'voice_ice', from: info.username, candidate: msg.candidate });
    }

    // DM CALL
    if (msg.type === 'dm_call' && info) {
      const target = getSocketByUsername(msg.to);
      if (target) send(target.socket, { type: 'dm_call_incoming', from: info.username, channel: msg.channel });
    }
  });

  socket.on('close', () => {
    const c = clients.get(socket);
    if (c) {
      clients.delete(socket);
      // remove from any voice rooms
      for (const [channel, members] of voiceRooms) {
        if (members.has(c.username)) {
          members.delete(c.username);
          for (const [s, info] of clients) {
            if (members.has(info.username)) {
              send(s, { type: 'voice_member_left', channel, username: c.username });
            }
          }
        }
      }
      broadcast({ type:'system', text:`${c.username} left the server.` });
      broadcastMembers();
    }
  });

  socket.on('error', () => { clients.delete(socket); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Rrcord running on port ${PORT}\n`);
});
