const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('load error:', e); }
  return { accounts:{}, friendships:{}, dmMessages:{}, memberCounter:0, servers:{}, serverChannels:{}, serverMembers:{}, serverMessages:{}, bans:{} };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      memberCounter,
      accounts:       Object.fromEntries(accounts),
      friendships:    Object.fromEntries([...friendships].map(([k,v])=>[k,[...v]])),
      dmMessages:     Object.fromEntries(dmMessages),
      servers:        Object.fromEntries(servers),
      serverChannels: Object.fromEntries(serverChannels),
      serverMembers:  Object.fromEntries([...serverMembers].map(([k,v])=>[k,[...v]])),
      serverMessages: Object.fromEntries(serverMessages),
      bans:           Object.fromEntries([...bans].map(([k,v])=>[k,[...v]])),
    }));
  } catch(e) { console.error('save error:', e); }
}

const saved = loadData();
let memberCounter = saved.memberCounter || 0;
const accounts       = new Map(Object.entries(saved.accounts || {}));
const friendships    = new Map(Object.entries(saved.friendships || {}).map(([k,v])=>[k,new Set(v)]));
const friendRequests = new Map();
const dmMessages     = new Map(Object.entries(saved.dmMessages || {}));
const servers        = new Map(Object.entries(saved.servers || {}));
const serverChannels = new Map(Object.entries(saved.serverChannels || {}));
const serverMembers  = new Map(Object.entries(saved.serverMembers || {}).map(([k,v])=>[k,new Set(v)]));
const serverMessages = new Map(Object.entries(saved.serverMessages || {}));
const bans           = new Map(Object.entries(saved.bans || {}).map(([k,v])=>[k,new Set(v)]));
const COLORS = ['#5b6af0','#3ddc84','#e05c5c','#f0a843','#b06ef0','#5eb0f0','#f06b9a','#4ecdc4'];
let colorIndex = 0;
const clients    = new Map();
const voiceRooms = new Map();

function hashPw(p,s)    { return crypto.createHash('sha256').update(s+p).digest('hex'); }
function getFriends(u)  { if(!friendships.has(u))    friendships.set(u,new Set());    return friendships.get(u); }
function getPending(u)  { if(!friendRequests.has(u)) friendRequests.set(u,new Set()); return friendRequests.get(u); }
function getSmems(sid)  { if(!serverMembers.has(sid))  serverMembers.set(sid,new Set());  return serverMembers.get(sid); }
function getBans(sid)   { if(!bans.has(sid))           bans.set(sid,new Set());           return bans.get(sid); }
function getSmsgs(cid)  { if(!serverMessages.has(cid)) serverMessages.set(cid,[]);        return serverMessages.get(cid); }
function getDMs(a,b)    { const k=[a,b].map(x=>x.toLowerCase()).sort().join('::'); if(!dmMessages.has(k)) dmMessages.set(k,[]); return dmMessages.get(k); }
function getConn(u)     { for(const[s,i]of clients) if(i.username.toLowerCase()===u.toLowerCase()) return{socket:s,info:i}; return null; }
function send(s,o)      { try{s.send(JSON.stringify(o));}catch(_){} }
function broadcastAll(o){ const d=JSON.stringify(o); for(const[s]of clients) if(s.readyState===1) try{s.send(d);}catch(_){} }
function broadcastSrv(sid,o,ex=null) {
  const m=getSmems(sid);
  for(const[s,i]of clients) if(s!==ex&&s.readyState===1&&m.has(i.username)) try{s.send(JSON.stringify(o));}catch(_){}
}
function broadcastMembers() {
  broadcastAll({type:'members',members:[...clients.values()].map(c=>({name:c.username,color:c.color,status:'online',memberNumber:c.memberNumber}))});
}
function serSrv(s) { return {id:s.id,name:s.name,emoji:s.emoji,ownerId:s.ownerId,inviteCode:s.inviteCode}; }
function getChs(sid) { return (serverChannels.get(sid)||[]).map(c=>({...c,serverId:sid})); }
function getHist(sid) { const h={}; (serverChannels.get(sid)||[]).forEach(c=>{h[c.id]=getSmsgs(c.id);}); return h; }
function getUserSrvs(u) { const r=[]; for(const[,s]of servers) if(getSmems(s.id).has(u)) r.push(serSrv(s)); return r; }
function getMemberList(sid) {
  return [...getSmems(sid)].map(u=>{const a=accounts.get(u.toLowerCase());return a?{name:a.username,color:a.color,memberNumber:a.memberNumber}:null;}).filter(Boolean);
}

const server = http.createServer((req,res)=>{
  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')) {
    fs.readFile(path.join(__dirname,'rrcord.html'),(err,data)=>{
      if(err){res.writeHead(404);res.end('rrcord.html not found');return;}
      res.writeHead(200,{'Content-Type':'text/html'});res.end(data);
    });return;
  }
  res.writeHead(404);res.end('Not found');
});

const wss = new WebSocketServer({server,path:'/ws'});
wss.on('connection',(socket)=>{
  let info=null;

  socket.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw.toString());}catch{return;}

    if(msg.type==='register') {
      const u=(msg.username||'').slice(0,24).trim(), p=(msg.password||'').trim();
      if(!u){send(socket,{type:'auth_error',text:'Username cannot be empty.'});return;}
      if(p.length<4){send(socket,{type:'auth_error',text:'Password must be at least 4 characters.'});return;}
      if(accounts.has(u.toLowerCase())){send(socket,{type:'auth_error',text:'Username already taken.'});return;}
      const salt=crypto.randomBytes(16).toString('hex'),hash=hashPw(p,salt);
      const color=COLORS[colorIndex++%COLORS.length],memberNumber=++memberCounter;
      accounts.set(u.toLowerCase(),{username:u,salt,hash,color,memberNumber});
      saveData();
      info={username:u,color,memberNumber};
      clients.set(socket,info);
      const friends=[...getFriends(u)].map(f=>{const a=accounts.get(f.toLowerCase());return a?{username:a.username,color:a.color,memberNumber:a.memberNumber}:null;}).filter(Boolean);
      send(socket,{type:'auth_ok',username:u,color,memberNumber,friends});
      send(socket,{type:'system',text:`Welcome to Rrcord, ${u}! 🎉`});
      broadcastAll({type:'system',text:`${u} just joined Rrcord!`});
      broadcastMembers();
    }

    if(msg.type==='login') {
      const u=(msg.username||'').slice(0,24).trim(),p=(msg.password||'').trim();
      const acc=accounts.get(u.toLowerCase());
      if(!acc){send(socket,{type:'auth_error',text:'Username not found.'});return;}
      if(hashPw(p,acc.salt)!==acc.hash){send(socket,{type:'auth_error',text:'Wrong password.'});return;}
      info={username:acc.username,color:acc.color,memberNumber:acc.memberNumber};
      clients.set(socket,info);
      const friends=[...getFriends(acc.username)].map(f=>{const a=accounts.get(f.toLowerCase());return a?{username:a.username,color:a.color,memberNumber:a.memberNumber}:null;}).filter(Boolean);
      send(socket,{type:'auth_ok',username:acc.username,color:acc.color,memberNumber:acc.memberNumber,friends});
      send(socket,{type:'system',text:`Welcome back, ${acc.username}!`});
      broadcastAll({type:'system',text:`${acc.username} is online.`});
      broadcastMembers();
    }

    if(msg.type==='get_servers'&&info) {
      send(socket,{type:'servers_list',servers:getUserSrvs(info.username)});
    }

    if(msg.type==='get_server_channels'&&info) {
      const sid=msg.serverId;
      if(!getSmems(sid).has(info.username)) return;
      send(socket,{type:'server_channels',serverId:sid,channels:getChs(sid)});
      send(socket,{type:'history',messages:getHist(sid)});
      send(socket,{type:'server_members',serverId:sid,members:getMemberList(sid)});
    }

    if(msg.type==='get_server_members'&&info) {
      const sid=msg.serverId;
      if(!getSmems(sid).has(info.username)) return;
      send(socket,{type:'server_members',serverId:sid,members:getMemberList(sid)});
    }

    if(msg.type==='create_server'&&info) {
      const name=(msg.name||'').slice(0,32).trim(),emoji=(msg.emoji||'🌐').slice(0,2);
      if(!name){send(socket,{type:'server_error',text:'Server name required.'});return;}
      const id=crypto.randomUUID(),inviteCode=crypto.randomBytes(3).toString('hex').toUpperCase();
      const s={id,name,emoji,ownerId:info.username,inviteCode};
      servers.set(id,s);
      serverChannels.set(id,[
        {id:crypto.randomUUID(),name:'general',type:'text', cat:'TEXT CHANNELS', topic:'Welcome to the server!'},
        {id:crypto.randomUUID(),name:'General',type:'voice',cat:'VOICE CHANNELS',topic:''},
      ]);
      getSmems(id).add(info.username);
      saveData();
      send(socket,{type:'server_created',server:serSrv(s)});
      console.log(`[server] ${info.username} created "${name}" (${inviteCode})`);
    }

    if(msg.type==='join_server'&&info) {
      const code=(msg.inviteCode||'').toUpperCase().trim();
      let found=null; for(const[,s]of servers) if(s.inviteCode===code){found=s;break;}
      if(!found){send(socket,{type:'server_error',text:'Invalid invite code.'});return;}
      if(getBans(found.id).has(info.username)){send(socket,{type:'server_error',text:"You've been banned from this server."});return;}
      if(getSmems(found.id).has(info.username)){send(socket,{type:'server_error',text:'Already in this server.'});return;}
      getSmems(found.id).add(info.username);
      saveData();
      send(socket,{type:'server_joined',server:serSrv(found)});
      broadcastSrv(found.id,{type:'system',text:`${info.username} joined the server!`},socket);
      broadcastSrv(found.id,{type:'server_members',serverId:found.id,members:getMemberList(found.id)});
      console.log(`[server] ${info.username} joined "${found.name}"`);
    }

    if(msg.type==='delete_server'&&info) {
      const sid=msg.serverId,s=servers.get(sid);
      if(!s||s.ownerId!==info.username){send(socket,{type:'server_error',text:'Not authorised.'});return;}
      broadcastSrv(sid,{type:'server_deleted',serverId:sid});
      servers.delete(sid);serverChannels.delete(sid);serverMembers.delete(sid);
      saveData();
    }

    if(msg.type==='create_channel'&&info) {
      const sid=msg.serverId,s=servers.get(sid);
      if(!s||s.ownerId!==info.username){send(socket,{type:'server_error',text:'Not authorised.'});return;}
      const name=(msg.name||'').slice(0,32).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
      const type=msg.chType==='voice'?'voice':'text';
      if(!name) return;
      const chs=serverChannels.get(sid)||[];
      const newCh={id:crypto.randomUUID(),name,type,cat:type==='voice'?'VOICE CHANNELS':'TEXT CHANNELS',topic:''};
      chs.push(newCh);serverChannels.set(sid,chs);saveData();
      broadcastSrv(sid,{type:'channel_created',channel:{...newCh,serverId:sid}});
    }

    if(msg.type==='delete_channel'&&info) {
      const sid=msg.serverId,s=servers.get(sid);
      if(!s||s.ownerId!==info.username){send(socket,{type:'server_error',text:'Not authorised.'});return;}
      serverChannels.set(sid,(serverChannels.get(sid)||[]).filter(c=>c.id!==msg.channelId));
      serverMessages.delete(msg.channelId);saveData();
      broadcastSrv(sid,{type:'channel_deleted',channelId:msg.channelId,serverId:sid});
    }

    if(msg.type==='kick_member'&&info) {
      const sid=msg.serverId,s=servers.get(sid);
      if(!s||s.ownerId!==info.username){send(socket,{type:'server_error',text:'Not authorised.'});return;}
      if(msg.username===info.username) return;
      getSmems(sid).delete(msg.username);getBans(sid).add(msg.username);saveData();
      const t=getConn(msg.username);
      if(t) send(t.socket,{type:'member_kicked',serverId:sid,serverName:s.name,username:msg.username});
      broadcastSrv(sid,{type:'member_kicked',serverId:sid,serverName:s.name,username:msg.username});
      broadcastSrv(sid,{type:'server_members',serverId:sid,members:getMemberList(sid)});
    }

    if(msg.type==='message'&&info) {
      const ch=msg.channel;
      let sid=null; for(const[k,chs]of serverChannels) if(chs.find(c=>c.id===ch)){sid=k;break;}
      if(!sid||!getSmems(sid).has(info.username)) return;
      const now=new Date();
      const entry={id:crypto.randomUUID(),author:info.username,color:info.color,text:msg.text.slice(0,2000),channel:ch,
        time:`Today at ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`,ts:Date.now()};
      const msgs=getSmsgs(ch); msgs.push(entry); if(msgs.length>200) msgs.shift(); saveData();
      broadcastSrv(sid,{type:'message',message:entry});
    }

    if(msg.type==='dm'&&info) {
      const toAcc=accounts.get((msg.to||'').toLowerCase());
      if(!toAcc){send(socket,{type:'dm_error',text:`User "${msg.to}" not found.`});return;}
      const ok=getFriends(info.username).has(toAcc.username)||getFriends(toAcc.username).has(info.username);
      if(!ok){send(socket,{type:'dm_error',text:'You can only DM friends.'});return;}
      const now=new Date();
      const entry={id:crypto.randomUUID(),author:info.username,color:info.color,to:toAcc.username,text:msg.text.slice(0,2000),
        time:`Today at ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`,ts:Date.now()};
      const dms=getDMs(info.username,toAcc.username); dms.push(entry); if(dms.length>200) dms.shift(); saveData();
      send(socket,{type:'dm_message',message:entry});
      const t=getConn(toAcc.username); if(t) send(t.socket,{type:'dm_message',message:entry});
    }

    if(msg.type==='dm_history'&&info) {
      const a=accounts.get((msg.with||'').toLowerCase()); if(!a) return;
      send(socket,{type:'dm_history',with:a.username,messages:getDMs(info.username,a.username)});
    }

    if(msg.type==='friend_request'&&info) {
      const to=(msg.to||'').trim(),acc=accounts.get(to.toLowerCase());
      if(!acc){send(socket,{type:'friend_request_sent',ok:false,text:`User "${to}" not found.`});return;}
      if(to.toLowerCase()===info.username.toLowerCase()){send(socket,{type:'friend_request_sent',ok:false,text:"Can't friend yourself!"});return;}
      if(getFriends(info.username).has(acc.username)){send(socket,{type:'friend_request_sent',ok:false,text:`Already friends with ${acc.username}.`});return;}
      if(getPending(acc.username).has(info.username)){send(socket,{type:'friend_request_sent',ok:false,text:'Request already sent.'});return;}
      getPending(acc.username).add(info.username);
      send(socket,{type:'friend_request_sent',ok:true,text:`Friend request sent to ${acc.username}!`,to:acc.username});
      const t=getConn(acc.username); if(t) send(t.socket,{type:'friend_request_received',from:info.username,color:info.color,memberNumber:info.memberNumber});
    }

    if(msg.type==='friend_response'&&info) {
      getPending(info.username).delete(msg.from);
      const a=accounts.get((msg.from||'').toLowerCase()); if(!a) return;
      if(msg.accept) {
        getFriends(info.username).add(a.username); getFriends(a.username).add(info.username); saveData();
        send(socket,{type:'friend_you_accepted',username:a.username,color:a.color,memberNumber:a.memberNumber});
        const t=getConn(a.username); if(t) send(t.socket,{type:'friend_accepted',username:info.username,color:info.color,memberNumber:info.memberNumber});
      } else {
        send(socket,{type:'friend_request_declined',username:a.username});
        const t=getConn(a.username); if(t) send(t.socket,{type:'friend_declined',username:info.username});
      }
    }

    if(msg.type==='friend_cancel'&&info) { const a=accounts.get((msg.to||'').toLowerCase()); if(a) getPending(a.username).delete(info.username); }

    if(msg.type==='friend_remove'&&info) {
      const a=accounts.get((msg.username||'').toLowerCase());
      if(a){getFriends(info.username).delete(a.username);getFriends(a.username).delete(info.username);saveData();
        const t=getConn(a.username); if(t) send(t.socket,{type:'friend_removed',username:info.username});}
    }

    if(msg.type==='reaction'&&info) { broadcastAll({type:'reaction',messageId:msg.messageId,emoji:msg.emoji,username:info.username}); }

    if(msg.type==='voice_join'&&info) {
      const ch=msg.channel; if(!voiceRooms.has(ch)) voiceRooms.set(ch,new Set());
      voiceRooms.get(ch).add(info.username);
      send(socket,{type:'voice_joined',channel:ch,members:[...voiceRooms.get(ch)]});
      for(const[s,c]of clients) if(s!==socket&&voiceRooms.get(ch).has(c.username)) send(s,{type:'voice_member_joined',channel:ch,username:info.username});
    }

    if(msg.type==='voice_leave'&&info) {
      const ch=msg.channel;
      if(voiceRooms.has(ch)){voiceRooms.get(ch).delete(info.username);
        for(const[s,c]of clients) if(s!==socket&&voiceRooms.get(ch).has(c.username)) send(s,{type:'voice_member_left',channel:ch,username:info.username});}
    }

    if(msg.type==='voice_offer'&&info)  { const t=getConn(msg.to); if(t) send(t.socket,{type:'voice_offer', from:info.username,sdp:msg.sdp}); }
    if(msg.type==='voice_answer'&&info) { const t=getConn(msg.to); if(t) send(t.socket,{type:'voice_answer',from:info.username,sdp:msg.sdp}); }
    if(msg.type==='voice_ice'&&info)    { const t=getConn(msg.to); if(t) send(t.socket,{type:'voice_ice',  from:info.username,candidate:msg.candidate}); }
    if(msg.type==='dm_call'&&info)      { const t=getConn(msg.to); if(t) send(t.socket,{type:'dm_call_incoming',from:info.username,channel:msg.channel}); }
  });

  socket.on('close',()=>{
    const c=clients.get(socket);
    if(c){
      clients.delete(socket);
      for(const[ch,mems]of voiceRooms) if(mems.has(c.username)){mems.delete(c.username);
        for(const[s,i]of clients) if(mems.has(i.username)) send(s,{type:'voice_member_left',channel:ch,username:c.username});}
      broadcastAll({type:'system',text:`${c.username} went offline.`});
      broadcastMembers();
    }
  });

  socket.on('error',()=>{clients.delete(socket);});
});

server.listen(PORT,'0.0.0.0',()=>{console.log(`\n🚀 Rrcord running on port ${PORT}\n`);});
