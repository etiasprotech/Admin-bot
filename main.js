"use strict";
require("dotenv").config();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const mongoose = require("mongoose");
const startServer = require("./server");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const P = require("pino");

const AUTH_DIR = path.join(__dirname, "auth");
const COMMANDS_DIR = path.join(__dirname, "commands");
const DATABASE_DIR = path.join(__dirname, "database");
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URL || process.env.MONGODB_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;

for (const dir of [AUTH_DIR, COMMANDS_DIR, DATABASE_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ========== MONGODB - MANY USERS ==========
const botSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, sparse: true },
  phone: { type: String, required: true, unique: true },
  number: String,
  expiry: Date,
  deployedAt: { type: Date, default: Date.now },
  duration: Number,
  liveConnected: Boolean
}, { strict: false });

const authStoreSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  files: [{ name: String, data: String }],
  updatedAt: { type: Date, default: Date.now }
});

let BotModel, AuthStoreModel;
const isMongo = () => mongoose.connection.readyState === 1;

async function connectMongo(){
    if(!MONGO_URI) return console.log("[MONGO] No URI - using local auth");
    try{
        await mongoose.connect(MONGO_URI);
        BotModel = mongoose.models.DeployedBot || mongoose.model("DeployedBot", botSchema);
        AuthStoreModel = mongoose.models.AuthStore || mongoose.model("AuthStore", authStoreSchema);
        console.log("[MONGO] Connected - Multi-user ready");
    }catch(e){ console.error("[MONGO] Failed:", e.message); }
}

async function saveAuthToMongo(phone){
    if(!isMongo() || !AuthStoreModel) return;
    try{
        const authPath = path.join(AUTH_DIR, phone);
        if(!fs.existsSync(authPath)) return;
        const files = await fsp.readdir(authPath);
        const data = [];
        for(const f of files){
            const content = await fsp.readFile(path.join(authPath, f));
            data.push({ name: f, data: content.toString("base64") });
        }
        await AuthStoreModel.findOneAndUpdate({ phone }, { phone, files: data, updatedAt: new Date() }, { upsert: true });
    }catch(e){ console.error("[MONGO SAVE] Failed", phone, e.message); }
}

async function loadAuthFromMongo(phone){
    if(!isMongo() || !AuthStoreModel) return false;
    try{
        const doc = await AuthStoreModel.findOne({ phone });
        if(!doc || !doc.files?.length) return false;
        const authPath = path.join(AUTH_DIR, phone);
        if(!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
        for(const file of doc.files){
            await fsp.writeFile(path.join(authPath, file.name), Buffer.from(file.data, "base64"));
        }
        console.log(`[MONGO] Restored auth for ${phone} (${doc.files.length} files)`);
        return true;
    }catch(e){ console.error("[MONGO LOAD] Failed", phone, e.message); return false; }
}

// ========== LOAD COMMANDS ==========
global.commands = new Map();
if(fs.existsSync(COMMANDS_DIR)){
    for(const file of fs.readdirSync(COMMANDS_DIR)){
        if(!file.endsWith(".js")) continue;
        try{
            delete require.cache[require.resolve(path.join(COMMANDS_DIR, file))];
            const cmd = require(path.join(COMMANDS_DIR, file));
            const name = (cmd.name || file.replace(".js","")).toLowerCase();
            global.commands.set(name, cmd);
            console.log(`[COMMAND] Loaded: ${name}`);
        }catch(e){ console.error(`[COMMAND] Failed ${file}:`, e.message); }
    }
    console.log(`[COMMANDS] ${global.commands.size} commands available`);
}

// ========== CREATE BOT ==========
async function Bot(phone){
    const authPath = path.join(AUTH_DIR, phone);
    if(!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, P({level:"silent"})) },
        logger: P({level:"silent"}),
        printQRInTerminal: false,
        browser: ["ETIAS-MINI", "Chrome", "1.0.0"],
        markOnlineOnConnect: true,
    });

    sock.ev.on("creds.update", async()=>{
        await saveCreds();
        await saveAuthToMongo(phone);
    });

    sock.ev.on("connection.update", async(u)=>{
        const { connection, lastDisconnect } = u;
        if(connection === "open"){
            console.log(`[CONNECT] ${phone} connected ✅`);
            if(isMongo() && BotModel){
                await BotModel.findOneAndUpdate({ phone }, { phone, liveConnected: true }, { upsert: true });
            }
            try{ await sock.sendMessage(sock.user.id, { text: "*ETIAS-MINI-BOT CONNECTED* ✅\nBot is online!" }); }catch{}
        }
        if(connection === "close"){
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[DISCONNECT] ${phone} - ${reason} : ${lastDisconnect?.error?.message}`);
            if(reason !== DisconnectReason.loggedOut){
                console.log(`[RECONNECT] ${phone} in 3s...`);
                setTimeout(()=>Bot(phone), 3000);
            } else {
                console.log(`[LOGOUT] ${phone} logged out - deleting auth`);
                try{
                    fs.rmSync(authPath, { recursive: true, force: true });
                    if(isMongo()){
                        await AuthStoreModel?.deleteOne({ phone });
                        await BotModel?.deleteOne({ phone });
                    }
                }catch{}
            }
        }
    });

    // Load your handler
    try{
        const handler = require("./handler");
        sock.ev.on("messages.upsert", (m)=> handler(m, sock));
    }catch(e){
        // If you handle messages inside main.js, put it here
        console.log("[HANDLER] Using internal handler - add your messages.upsert logic");
    }

    return sock;
}

async function AuthStore(phone){ return path.join(AUTH_DIR, phone); }

// ========== RESTORE ALL BOTS ==========
async function restoreBots(){
    await connectMongo();
    if(!isMongo()) return console.log("[RESTORE] No Mongo - skip");

    const accounts = fs.existsSync(AUTH_DIR) ? fs.readdirSync(AUTH_DIR).filter(f=>fs.statSync(path.join(AUTH_DIR, f)).isDirectory()) : [];
    
    // Also get from Mongo if folder empty
    let mongoAccounts = [];
    try{
        const docs = await AuthStoreModel.find({});
        mongoAccounts = docs.map(d=>d.phone);
        console.log(`[RESTORE] MongoDB has ${mongoAccounts.length} saved users`);
    }catch{}

    const allPhones = [...new Set([...accounts, ...mongoAccounts])];
    if(!allPhones.length) return console.log("[RESTORE] No saved accounts");

    console.log(`[RESTORE] ${allPhones.length} account(s) found - connecting...`);
    for(const phone of allPhones){
        console.log(`[RESTORE] → ${phone}...`);
        try{
            await loadAuthFromMongo(phone);
            await Bot(phone);
            console.log(`[RESTORE] ${phone} initialized`);
        }catch(e){ console.error(`[RESTORE] Failed ${phone}:`, e.message); }
        await new Promise(r=>setTimeout(r, 2500));
    }

    if(isMongo()){
        setInterval(async()=>{
            for(const phone of allPhones){
                await saveAuthToMongo(phone);
                await new Promise(r=>setTimeout(r,500));
            }
        }, 120000);
    }
}

// ========== START ==========
async function start(){
    console.log(`
╔════════════════════════════════════════════╗
║            ETIAS-MINI-BOT                 ║
║            MULTI ACCOUNT BOT              ║
╠════════════════════════════════════════════╣
║ Pairing: Phone Number                     ║
║ MongoDB: ${MONGO_URI ? "ENABLED (Many Users)" : "DISABLED (Local only)"} ║
║ Commands: ENABLED                         ║
║ Auto Restore: ENABLED                     ║
║ Welcome Msg: *ETIAS-MINI-BOT CONNECTED*   ║
║ AntiDelete/Link/ViewOnce: ENABLED         ║
╚════════════════════════════════════════════╝`);

    try{ 
        if(typeof startServer === 'function') startServer();
        else if(typeof startServer.startServer === 'function') startServer.startServer();
        else if(typeof startServer.default === 'function') startServer.default();
    }catch(e){ console.error("[SERVER] Failed:", e.message); }

    await restoreBots();

    console.log("[SYSTEM] ETIAS-MINI-BOT ready - supports many users");
}

start().catch(e=>console.error("[SYSTEM] Startup error:", e));

process.on("uncaughtException", e=>console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", e=>console.error("[UNHANDLED]", e));
process.on("SIGINT", ()=>{ console.log("\n[SYSTEM] Shutting down..."); process.exit(0); });
process.on("SIGTERM", ()=>{ console.log("\n[SYSTEM] SIGTERM..."); process.exit(0); });

module.exports = { Bot, AuthStore, saveAuthToMongo, loadAuthFromMongo, createBot: Bot };
