"use strict";
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth");
const DATABASE_DIR = path.join(__dirname, "database");
const MEDIA_DIR = path.join(__dirname, "media");
const ANTIDELETE_DB = path.join(DATABASE_DIR, "antidelete.json");
const ANTILINK_DB = path.join(DATABASE_DIR, "antilink.json");
const ANTIVIEWONCE_DB = path.join(DATABASE_DIR, "antiviewonce.json");
const MESSAGE_STORE = path.join(DATABASE_DIR, "messageStore.json");

for (const dir of [AUTH_DIR, DATABASE_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function ensureJSON(file, value = {}) { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
ensureJSON(ANTIDELETE_DB); ensureJSON(ANTILINK_DB); ensureJSON(ANTIVIEWONCE_DB); ensureJSON(MESSAGE_STORE);
function readJSON(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(`[DATABASE] ${e.message}`); } }
function getAntideleteDB() { return readJSON(ANTIDELETE_DB, {}); }
function getAntilinkDB() { return readJSON(ANTILINK_DB, {}); }
function getAntiviewonceDB() { return readJSON(ANTIVIEWONCE_DB, {}); }
function getMessageStore() { return readJSON(MESSAGE_STORE, {}); }

const sessions = new Map();
function normalizePhone(phone){ if(!phone) return ""; return String(phone).replace(/\D/g,"").replace(/^00/,""); }
function validatePhone(phone){ const n=normalizePhone(phone); return n.length>=8 && n.length<=15; }
function getAuthPath(phone){ return path.join(AUTH_DIR, normalizePhone(phone)); }
function getChatId(msg){ return msg?.key?.remoteJid || ""; }
function getSender(msg){ return msg?.key?.participant || msg?.key?.remoteJid || ""; }
function getMessageText(msg){
    let message = msg?.message; if(!message) return "";
    if(message.ephemeralMessage?.message) message=message.ephemeralMessage.message;
    if(message.viewOnceMessage?.message) message=message.viewOnceMessage.message;
    if(message.viewOnceMessageV2?.message) message=message.viewOnceMessageV2.message;
    if(message.viewOnceMessageV2Extension?.message) message=message.viewOnceMessageV2Extension.message;
    if(message.documentWithCaptionMessage?.message) message=message.documentWithCaptionMessage.message;
    if(message.editedMessage?.message) message=message.editedMessage.message;
    return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || message.buttonsResponseMessage?.selectedButtonId || message.listResponseMessage?.singleSelectReply?.selectedRowId || message.templateButtonReplyMessage?.selectedId || message.interactiveResponseMessage?.body?.text || message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || "";
}
function getMessageType(message){ if(!message) return "unknown"; return Object.keys(message)[0] || "unknown"; }
function getMessageContent(message){ if(!message) return ""; return message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || ""; }
const LINK_REGEX = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/|instagram\.com\/|facebook\.com\/|youtube\.com\/|youtu\.be\/)/i;

function saveIncomingMessage(msg){
    try{
        if(!msg?.message) return;
        if(msg.message?.protocolMessage) return;
        const id=msg.key?.id; if(!id) return;
        const store=getMessageStore();
        store[id]={ chatId:msg.key.remoteJid, sender:msg.key.participant || msg.key.remoteJid, content:getMessageContent(msg.message), message:msg.message, timestamp:Date.now(), type:getMessageType(msg.message) };
        const keys=Object.keys(store); if(keys.length>500){ keys.sort((a,b)=>store[a].timestamp-store[b].timestamp); const removeCount=keys.length-500; for(let i=0;i<removeCount;i++) delete store[keys[i]]; }
        writeJSON(MESSAGE_STORE, store);
    }catch(e){ console.error("[MESSAGE STORE]", e.message); }
}
async function getGroupInfo(sock, chatId, sender){
    try{
        if(!chatId.endsWith("@g.us")) return {isGroup:false,isAdmin:false,isBotAdmin:false,metadata:null};
        const metadata=await sock.groupMetadata(chatId);
        const participant=metadata.participants.find(p=>p.id===sender);
        const botId=sock.user?.id?.split(":")[0]; const botJid=botId?`${botId}@s.whatsapp.net`:"";
        const botParticipant=metadata.participants.find(p=>p.id===botJid);
        return {isGroup:true,isAdmin:participant?.admin==="admin"||participant?.admin==="superadmin",isBotAdmin:botParticipant?.admin==="admin"||botParticipant?.admin==="superadmin",metadata};
    }catch{ return {isGroup:true,isAdmin:false,isBotAdmin:false,metadata:null}; }
}
function extractViewOnce(message){
    if(!message) return null;
    if(message.viewOnceMessage?.message) return {message:message.viewOnceMessage.message};
    if(message.viewOnceMessageV2?.message) return {message:message.viewOnceMessageV2.message};
    if(message.viewOnceMessageV2Extension?.message) return {message:message.viewOnceMessageV2Extension.message};
    return null;
}
async function handleAntiViewOnce(sock, msg, phone){
    try{
        if(!msg?.message) return; if(msg.key?.fromMe) return; const chatId=msg.key.remoteJid; if(!chatId) return;
        const db=getAntiviewonceDB(); if(!db[chatId]) return;
        const extracted=extractViewOnce(msg.message); if(!extracted) return;
        const inner=extracted.message; const innerType=Object.keys(inner)[0]; if(!innerType) return; const media=inner[innerType]; if(!media) return;
        let type; if(innerType==="imageMessage") type="image"; else if(innerType==="videoMessage") type="video"; else if(innerType==="audioMessage") type="audio"; else return;
        const sender=getSender(msg);
        let buffer=Buffer.alloc(0); const stream=await downloadContentFromMessage(media,type); for await(const chunk of stream) buffer=Buffer.concat([buffer,chunk]); if(!buffer.length) return;
        const mention=sender?`@${sender.split("@")[0]}`:"Unknown";
        await sock.sendMessage(chatId,{text:`╭━━━〔 *ANTIVIEWONCE* 〕━━━\n┃ 👤 Sender: ${mention}\n┃ 📎 Type: ${type.toUpperCase()}\n┃ 👁️ View-once recovered\n╰━━━━━━━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*`,mentions:sender?[sender]:[]});
        if(type==="image") await sock.sendMessage(chatId,{image:buffer,caption:media.caption||"👁️ View-once image recovered\n\n> POWERED BY ETIAS-TECH"});
        else if(type==="video") await sock.sendMessage(chatId,{video:buffer,caption:media.caption||"👁️ View-once video recovered\n\n> POWERED BY ETIAS-TECH",mimetype:media.mimetype||"video/mp4"});
        else if(type==="audio") await sock.sendMessage(chatId,{audio:buffer,mimetype:media.mimetype||"audio/mp4",ptt:media.ptt||false});
    }catch(e){ console.error(`[${phone}] [ANTIVIEWONCE]`, e.message); }
}
async function handleAntiLink(sock, msg, phone){
    try{
        if(!msg?.message) return; if(msg.key?.fromMe) return; const chatId=msg.key.remoteJid; if(!chatId||!chatId.endsWith("@g.us")) return;
        const db=getAntilinkDB(); const config=db[chatId]; if(!config||!config.enabled) return;
        const text=getMessageText(msg); if(!text) return; if(!LINK_REGEX.test(text)) return;
        const sender=getSender(msg); const group=await getGroupInfo(sock,chatId,sender); if(group.isAdmin) return; if(!group.isBotAdmin) return;
        try{ const inviteCode=await sock.groupInviteCode(chatId); if(inviteCode&&text.includes(inviteCode)) return; }catch{}
        try{ await sock.sendMessage(chatId,{delete:msg.key}); }catch{}
        const action=config.action||"delete";
        if(action==="delete"){ await sock.sendMessage(chatId,{text:`⚠️ @${sender.split("@")[0]} Links are not allowed!\n\n> *POWERED BY ETIAS-TECH*`,mentions:[sender]}); return; }
        if(action==="warn"){
            config.warnCount=config.warnCount||{}; config.warnCount[sender]=(config.warnCount[sender]||0)+1; const warnings=config.warnCount[sender];
            if(warnings>=3){ await sock.sendMessage(chatId,{text:`🔨 @${sender.split("@")[0]} kicked after 3 link warnings!\n\n> *POWERED BY ETIAS-TECH*`,mentions:[sender]}); try{ await sock.groupParticipantsUpdate(chatId,[sender],"remove"); }catch{} config.warnCount[sender]=0; }
            else{ await sock.sendMessage(chatId,{text:`⚠️ @${sender.split("@")[0]} Warning ${warnings}/3\n\nLinks are not allowed!`,mentions:[sender]}); }
            writeJSON(ANTILINK_DB, db); return;
        }
        if(action==="kick"){ await sock.sendMessage(chatId,{text:`🔨 @${sender.split("@")[0]} kicked for sending a link!\n\n> *POWERED BY ETIAS-TECH*`,mentions:[sender]}); try{ await sock.groupParticipantsUpdate(chatId,[sender],"remove"); }catch{} }
    }catch(e){ console.error(`[${phone}] [ANTILINK]`, e.message); }
}
async function handleAntiDelete(sock, msg, phone){
    try{
        const protocol=msg?.message?.protocolMessage; if(!protocol) return; if(protocol.type!==0) return;
        const deletedKey=protocol.key; if(!deletedKey?.id) return; const chatId=deletedKey.remoteJid||msg.key.remoteJid; if(!chatId) return;
        const db=getAntideleteDB(); if(!db[chatId]) return;
        const store=getMessageStore(); const saved=store[deletedKey.id]; if(!saved) return;
        const sender=saved.sender||chatId; const mention=`@${sender.split("@")[0]}`;
        await sock.sendMessage(chatId,{text:`╭━━━〔 *ANTIDELETE* 〕━━━\n┃ 🗑️ Deleted message recovered\n┃ 👤 Sender: ${mention}\n┃ 📎 Type: ${saved.type}\n╰━━━━━━━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*`,mentions:[sender]});
        if(saved.type==="conversation"||saved.type==="extendedTextMessage"){ if(saved.content) await sock.sendMessage(chatId,{text:`💬 *Deleted message:*\n\n${saved.content}\n\n> *POWERED BY ETIAS-TECH*`}); return; }
        if(saved.message?.imageMessage){ try{ const media=saved.message.imageMessage; const stream=await downloadContentFromMessage(media,"image"); let buffer=Buffer.alloc(0); for await(const chunk of stream) buffer=Buffer.concat([buffer,chunk]); await sock.sendMessage(chatId,{image:buffer,caption:media.caption||"🗑️ Deleted image recovered\n\n> POWERED BY ETIAS-TECH"}); }catch{ await sock.sendMessage(chatId,{text:"📷 Deleted image detected, but media could not be recovered."}); } return; }
        if(saved.message?.videoMessage){ try{ const media=saved.message.videoMessage; const stream=await downloadContentFromMessage(media,"video"); let buffer=Buffer.alloc(0); for await(const chunk of stream) buffer=Buffer.concat([buffer,chunk]); await sock.sendMessage(chatId,{video:buffer,caption:media.caption||"🗑️ Deleted video recovered\n\n> POWERED BY ETIAS-TECH",mimetype:media.mimetype||"video/mp4"}); }catch{ await sock.sendMessage(chatId,{text:"🎥 Deleted video detected, but media could not be recovered."}); } return; }
        if(saved.message?.audioMessage){ try{ const media=saved.message.audioMessage; const stream=await downloadContentFromMessage(media,"audio"); let buffer=Buffer.alloc(0); for await(const chunk of stream) buffer=Buffer.concat([buffer,chunk]); await sock.sendMessage(chatId,{audio:buffer,mimetype:media.mimetype||"audio/mp4",ptt:media.ptt||false}); }catch{ await sock.sendMessage(chatId,{text:"🎵 Deleted audio detected, but media could not be recovered."}); } return; }
        await sock.sendMessage(chatId,{text:`📎 Deleted ${saved.type} detected.\n\nContent: ${saved.content||"[media]"}`});
    }catch(e){ console.error(`[${phone}] [ANTIDELETE]`, e.message); }
}
async function processMessageFeatures(sock, msg, phone){ try{ saveIncomingMessage(msg); await handleAntiDelete(sock,msg,phone); await handleAntiViewOnce(sock,msg,phone); await handleAntiLink(sock,msg,phone); }catch(e){ console.error(`[${phone}] Feature pipeline error:`, e.message); } }

function attachMessageHandler(sock, phone){
    if(sock.__ETIAS_MESSAGE_HANDLER) return; sock.__ETIAS_MESSAGE_HANDLER=true;
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try{
            if(!Array.isArray(messages)) return;
            for(const msg of messages){
                try{
                    if(!msg) continue; const fromMe=Boolean(msg.key?.fromMe); const chatId=getChatId(msg); if(!chatId) continue; if(chatId==="status@broadcast") continue;
                    if(!msg.message || typeof msg.message!=="object" || Object.keys(msg.message).length===0) continue;
                    const text=String(getMessageText(msg)||"").trim();
                    if(text){
                        const prefix=global.botConfig?.prefix||".";
                        if(text.startsWith(prefix)){
                            const body=text.slice(prefix.length).trim();
                            if(body){
                                const parts=body.split(/\s+/); const commandName=String(parts.shift()||"").toLowerCase(); const args=parts;
                                const commandMap=global.commands;
                                if(commandMap){ const command=commandMap.get(commandName); if(command&&typeof command.execute==="function"){ try{ await command.execute(sock,msg,args); }catch(ce){ try{ await sock.sendMessage(chatId,{text:`❌ Command error:\n\n${ce?.message||ce}\n\n> *POWERED BY ETIAS-TECH*`},{quoted:msg}); }catch{} } } }
                            }
                        }
                    }
                    if(!fromMe){ try{ await processMessageFeatures(sock,msg,phone); }catch{} }
                }catch{}
            }
        }catch(e){ console.error(`[${phone}] MESSAGES.UPSERT ERROR:`, e); }
    });
}

async function createBot(phone){
    phone=normalizePhone(phone); if(!validatePhone(phone)) throw new Error("Invalid phone number");
    const existing=sessions.get(phone); if(existing?.sock && existing.status!=="closed") return existing.sock;
    const authPath=getAuthPath(phone); if(!fs.existsSync(authPath)) fs.mkdirSync(authPath,{recursive:true});
    const {state, saveCreds}=await useMultiFileAuthState(authPath);
    let version; try{ const latest=await fetchLatestBaileysVersion(); version=latest.version; }catch{ version=[2,3000,1015901307]; }
    const logger=pino({level:process.env.BAILEYS_LOG_LEVEL||"silent"});
    const sock=makeWASocket({ version, logger, printQRInTerminal:false, auth:{creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys,logger)}, markOnlineOnConnect:true, generateHighQualityLinkPreview:false, syncFullHistory:false, getMessage: async key=>{ try{ const store=getMessageStore(); return store[key.id]?.message||undefined; }catch{ return undefined; } } });
    const session={sock,phone,status:"connecting",pairingCode:null,reconnecting:false,startedAt:Date.now(), welcomeSent:false};
    sessions.set(phone, session);
    attachMessageHandler(sock, phone);
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async update=>{
        const {connection,lastDisconnect}=update;
        if(connection==="open"){
            session.status="open"; session.reconnecting=false; session.pairingCode=null;
            console.log(`\n╔════════════════════════════╗\n║ ETIAS-MINI-BOT CONNECTED ║\n║ Phone: ${phone} ║\n╚════════════════════════════╝\n`);

            // ===== SEND CONNECTED MESSAGE =====
            if(!session.welcomeSent){
                session.welcomeSent=true;
                try{
                    await new Promise(r=>setTimeout(r,2000)); // wait 2s for socket ready
                    const botJid = sock.user?.id;
                    const myNumberJid = `${phone}@s.whatsapp.net`;

                    const welcomeText = `*ETIAS-MINI-BOT CONNECTED* ✅

Your bot is now ONLINE and working!

╭━━━━━━━━━━━━━━━━━━
┃ 🤖 Bot: ETIAS-MINI-BOT
┃ 📱 Number: ${phone}
┃ ⚡ Status: Active
┃ 🔥 Features: Antilink, Antidelete, AntiViewOnce
╰━━━━━━━━━━━━━━━━━━

Type *.menu* to see commands
Type *.help* for support

> *POWERED BY ETIAS-TECH*`;

                    // Send to self (your WhatsApp)
                    if(botJid){
                        await sock.sendMessage(botJid, { text: welcomeText }).catch(()=>{});
                    }
                    // Also try sending to your number jid
                    if(myNumberJid!== botJid){
                        await sock.sendMessage(myNumberJid, { text: welcomeText }).catch(()=>{});
                    }
                    console.log(`[${phone}] ✅ Welcome message sent`);
                }catch(e){
                    console.error(`[${phone}] Welcome send failed:`, e.message);
                }
            }
        }
        if(connection==="close"){
            session.status="closed"; let code; try{code=lastDisconnect?.error?.output?.statusCode;}catch{code=undefined;}
            const shouldReconnect=code!==DisconnectReason.loggedOut;
            if(!shouldReconnect){ sessions.delete(phone); return; }
            if(session.reconnecting) return; session.reconnecting=true;
            setTimeout(async()=>{ try{ sessions.delete(phone); await createBot(phone); }catch{} },10000);
        }
    });
    if(!state.creds.registered){
        setTimeout(async()=>{ try{ const code=await sock.requestPairingCode(phone); session.pairingCode=code; console.log(`[${phone}] Pairing Code: ${code}`); }catch(e){ console.error(`[${phone}] ❌ Pairing code failed:`, e.message); } },1500);
    }
    return sock;
}

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true, limit:"10mb"}));

// PAIRING UI - premium style
app.get("/", (req, res) => {
res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ETIAS-MINI-BOT | Pairing</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Space Grotesk',sans-serif;background:#050706;color:#fff;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(900px at 50% -10%, #00ff8822, transparent 60%), radial-gradient(700px at 100% 100%, #00ff8812, transparent);pointer-events:none}
.scanline{position:fixed;left:0;width:100%;height:2px;background:rgba(0,255,136,.25);box-shadow:0 0 25px rgba(0,255,136,.4);animation:scan 6s linear infinite;pointer-events:none;z-index:10}@keyframes scan{0%{top:-5px}100%{top:110%}}
.header{width:100%;padding:28px 20px 10px;text-align:center}.logo{font-size:clamp(26px,7vw,46px);font-weight:800;letter-spacing:3px;color:#eafff3;text-shadow:0 0 20px rgba(0,255,136,.6)}.logo b{color:#00ff88}.subtitle{margin-top:8px;color:#5d7a67;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.container{width:min(94%,560px);margin:22px auto 70px}.card{position:relative;padding:26px;border:1px solid #1a2d23;border-radius:28px;background:linear-gradient(180deg,#111a14,#0a0f0c);box-shadow:0 30px 80px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05);overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:20%;width:60%;height:1px;background:linear-gradient(90deg,transparent,#00ff88,transparent)}
.status{display:flex;align-items:center;gap:10px;padding:11px 14px;margin-bottom:20px;border:1px solid #1a2d23;border-radius:100px;background:#080b09;color:#8ab89a;font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:1px}
.status-dot{width:8px;height:8px;border-radius:50%;background:#00ff88;box-shadow:0 0 12px #00ff88;animation:pulse 1.4s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4;transform:scale(.8)}}
.section-title{font-size:22px;font-weight:800;margin-bottom:6px}.description{color:#6a8572;font-size:13px;line-height:1.6;margin-bottom:20px}
.label{display:block;color:#8ec9a0;font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;margin-bottom:8px}
.input-wrap{display:flex;align-items:center;border:1px solid #1e2e26;border-radius:16px;background:#070a08;transition:.2s}.input-wrap:focus-within{border-color:#00ff88;box-shadow:0 0 0 4px #00ff8820}
.prefix{padding-left:16px;color:#00ff88;font-weight:700;font-size:15px;font-family:'JetBrains Mono',monospace}input{width:100%;padding:15px 16px;border:0;outline:0;background:transparent;color:#fff;font-size:15px;font-family:'JetBrains Mono',monospace}input::placeholder{color:#2a3d31}
.generate{width:100%;margin-top:14px;padding:15px;border:0;border-radius:16px;background:#00ff88;color:#00210f;font-size:14px;font-weight:800;letter-spacing:.8px;cursor:pointer;box-shadow:0 0 25px rgba(0,255,136,.35);transition:.2s}.generate:hover{background:#5dffad;transform:translateY(-1px)}.generate:disabled{opacity:.5}
.result{display:none;margin-top:20px;padding:18px;border:1px solid #00ff8830;border-radius:20px;background:#07110a}.result.show{display:block}
.result-title{color:#5d7a67;font-size:10px;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-family:'JetBrains Mono',monospace}.code{display:block;text-align:center;padding:16px 10px;border-radius:14px;background:#000;border:1px solid #00ff8850;color:#00ff88;font-size:28px;font-weight:800;letter-spacing:8px;text-shadow:0 0 15px rgba(0,255,136,.7);font-family:'JetBrains Mono',monospace;word-break:break-all}
.copy{width:100%;margin-top:10px;padding:11px;border:1px solid #1e2e26;border-radius:12px;background:#0e1410;color:#9ec9ab;cursor:pointer;font-weight:700;font-size:12px}.copy:hover{border-color:#00ff88;color:#fff}
.instructions{margin-top:20px}.step{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #111a14;color:#8a9f92;font-size:13px}.step-number{flex:0 0 26px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#00ff8815;border:1px solid #00ff8830;color:#00ff88;font-weight:800;font-size:12px}
.account-status{margin-top:18px;padding:14px;border-radius:14px;background:#080b09;border:1px solid #141e16;color:#6a8572;font-size:12px;text-align:center;font-family:'JetBrains Mono',monospace}.account-status strong{color:#00ff88}
.features{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:20px}.feature{padding:12px;border:1px solid #141e16;border-radius:14px;background:#080b09;color:#5d7a67;font-size:11px;font-family:'JetBrains Mono',monospace}.feature span{display:block;color:#00ff88;font-weight:700;margin-bottom:4px;font-size:12px;font-family:'Space Grotesk',sans-serif}
.footer{text-align:center;padding:0 20px 35px;color:#2a3d31;font-size:10px;letter-spacing:2px;font-family:'JetBrains Mono',monospace}
</style></head>
<body><div class="scanline"></div><header class="header"><div class="logo">🤖 ETIAS-<b>MINI</b></div><div class="subtitle">Bringing AI To Your Fingertips • 24/7</div></header>
<main class="container"><div class="card"><div class="status"><div class="status-dot"></div><span id="serverStatus">PAIRING SERVER ONLINE • SECURE</span></div>
<div class="section-title">Connect WhatsApp</div><div class="description">Enter your WhatsApp number. We'll generate a real 8-digit pairing code.</div>
<label class="label">WhatsApp Phone Number</label><div class="input-wrap"><span class="prefix">+</span><input id="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="263778810589"></div>
<button id="generateBtn" class="generate" onclick="generateCode()">⚡ GENERATE PAIRING CODE</button>
<div id="result" class="result"><div class="result-title">Your Pairing Code</div><span id="code" class="code">--------</span><button class="copy" onclick="copyCode()">📋 Copy Code</button></div>
<div class="instructions"><div class="step"><div class="step-number">1</div><div>Open WhatsApp → Settings</div></div><div class="step"><div class="step-number">2</div><div>Linked Devices → Link a device</div></div><div class="step"><div class="step-number">3</div><div>Link with phone number → Enter code</div></div></div>
<div class="account-status" id="accountStatus">Status: <strong>Waiting for number</strong></div>
<div class="features"><div class="feature"><span>🛡️ Antidelete</span>Recover deleted</div><div class="feature"><span>🔗 Antilink</span>Block links</div><div class="feature"><span>👁️ AntiViewOnce</span>Save view-once</div><div class="feature"><span>⚡ Fast Pair</span>Real Baileys</div></div>
</div></main><div class="footer">POWERED BY ETIAS-TECH • SECURE • ENCRYPTED</div>
<script>
const phoneInput=document.getElementById('phone');const generateBtn=document.getElementById('generateBtn');const resultDiv=document.getElementById('result');const codeSpan=document.getElementById('code');const statusDiv=document.getElementById('accountStatus');
function copyCode(){ const c=codeSpan.textContent.trim(); if(!c||c.includes('-')) return; navigator.clipboard.writeText(c).then(()=>{ const btn=document.querySelector('.copy'); const t=btn.textContent; btn.textContent='✅ Copied!'; setTimeout(()=>btn.textContent=t,1500); }); }
async function generateCode(){
  const phone=phoneInput.value.trim(); if(!phone){ alert('Enter phone'); return; }
  generateBtn.disabled=true; generateBtn.textContent='⏳ GENERATING...'; statusDiv.innerHTML='Status: <strong>Connecting...</strong>';
  try{
    const res=await fetch('/pair?phone='+encodeURIComponent(phone)); const data=await res.json(); if(!data.success) throw new Error(data.error||'Failed');
    let iv=null; const poll=async()=>{ try{ const r=await fetch('/status?phone='+encodeURIComponent(phone)); const j=await r.json(); if(j.pairingCode){ codeSpan.textContent=j.pairingCode; resultDiv.classList.add('show'); statusDiv.innerHTML='Status: <strong style="color:#00ff88">Code ready</strong>'; generateBtn.textContent='⚡ CODE GENERATED'; } if(j.status==='open'){ statusDiv.innerHTML='Status: <strong style="color:#00ff88">✅ CONNECTED</strong>'; clearInterval(iv); generateBtn.textContent='✅ CONNECTED'; generateBtn.disabled=false; } }catch{} };
    iv=setInterval(poll,2000); poll(); setTimeout(()=>{ if(iv) clearInterval(iv); },90000);
  }catch(e){ alert(e.message); statusDiv.innerHTML='Status: <strong style="color:#ff6b6b">Error: '+e.message+'</strong>'; }
  finally{ setTimeout(()=>{ generateBtn.disabled=false; },2000); }
}
</script></body></html>`);
});

app.get("/pair", async (req,res)=>{
    try{
        const phone=normalizePhone(req.query.phone); if(!validatePhone(phone)) return res.status(400).json({success:false, error:"Invalid phone"});
        await createBot(phone); const sess=sessions.get(phone);
        return res.json({success:true, phone, status:sess?.status||"connecting", pairingCode:sess?.pairingCode||null});
    }catch(e){ return res.status(500).json({success:false, error:e.message}); }
});
app.get("/status", (req,res)=>{
    const phone=normalizePhone(req.query.phone); const sess=sessions.get(phone);
    if(!sess) return res.json({success:false, status:"not_found"});
    return res.json({success:true, phone, status:sess.status, pairingCode:sess.pairingCode||null});
});

app.listen(PORT, ()=>console.log(`ETIAS-MINI-BOT Pairing Running on ${PORT}`));
