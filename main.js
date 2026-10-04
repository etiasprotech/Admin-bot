"use strict";
require("dotenv").config();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const mongoose = require("mongoose");
const { createBot, startServer } = require("./server");

const AUTH_DIR = path.join(__dirname, "auth");
const COMMANDS_DIR = path.join(__dirname, "commands");
const DATABASE_DIR = path.join(__dirname, "database");
const MONGO_URI = process.env.MONGO_URI;
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
  files: [{ name: String, data: String }], // base64
  updatedAt: { type: Date, default: Date.now }
});

const Bot = mongoose.models.DeployedBot || mongoose.model('DeployedBot', botSchema);
const AuthStore = mongoose.models.AuthStore || mongoose.model('AuthStore', authStoreSchema);

async function connectMongo(){
  if(!MONGO_URI){ console.log("[MONGO] No MONGO_URI - using local only"); return false; }
  try{
    await mongoose.connect(MONGO_URI);
    console.log("[MONGO] Connected - Multi-user ready");
    return true;
  }catch(e){ console.error("[MONGO] Failed:", e.message); return false; }
}
function isMongo(){ return mongoose.connection.readyState===1; }

async function saveAuthToMongo(phone){
  if(!isMongo()) return;
  try{
    const authPath = path.join(AUTH_DIR, phone);
    if(!fs.existsSync(authPath)) return;
    const files = await fsp.readdir(authPath);
    const stored=[];
    for(const f of files){
      try{
        const full = path.join(authPath, f);
        const stat = await fsp.stat(full);
        if(!stat.isFile()) continue;
        const data = await fsp.readFile(full);
        stored.push({ name: f, data: data.toString('base64') });
      }catch{}
    }
    if(stored.length===0) return;
    await AuthStore.findOneAndUpdate({phone},{phone,files:stored,updatedAt:new Date()},{upsert:true});
    // console.log(`[MONGO] Auth backed up for ${phone} (${stored.length} files)`);
  }catch(e){ console.error(`[MONGO] Backup failed ${phone}:`, e.message); }
}

async function loadAuthFromMongo(phone){
  if(!isMongo()) return false;
  try{
    const doc = await AuthStore.findOne({phone});
    if(!doc || !doc.files || doc.files.length===0) return false;
    const authPath = path.join(AUTH_DIR, phone);
    if(!fs.existsSync(authPath)) fs.mkdirSync(authPath,{recursive:true});
    // Only restore if creds.json missing
    const credsPath = path.join(authPath, 'creds.json');
    if(fs.existsSync(credsPath)) return false;
    for(const f of doc.files){
      try{
        await fsp.writeFile(path.join(authPath, f.name), Buffer.from(f.data,'base64'));
      }catch{}
    }
    console.log(`[MONGO] Restored auth for ${phone} (${doc.files.length} files)`);
    return true;
  }catch(e){ console.error(`[MONGO] Restore failed ${phone}:`, e.message); return false; }
}

// ========== COMMAND SYSTEM ==========
const commands = new Map();
function loadCommands() {
    commands.clear();
    if (!fs.existsSync(COMMANDS_DIR)) return;
    const files = fs.readdirSync(COMMANDS_DIR).filter(f=>f.endsWith(".js"));
    for(const file of files){
        const filePath = path.join(COMMANDS_DIR, file);
        try{
            delete require.cache[require.resolve(filePath)];
            const command = require(filePath);
            if(!command) continue;
            const name = command.name || command.command || command.cmd;
            if(!name){
                if(typeof command.init==="function" || typeof command.register==="function" || typeof command.onMessage==="function"){
                    console.log(`[COMMAND] Loaded event module: ${file}`);
                }
                continue;
            }
            const commandName = String(name).toLowerCase();
            commands.set(commandName, command);
            console.log(`[COMMAND] Loaded: ${commandName}`);
            const aliases = Array.isArray(command.aliases)?command.aliases:[];
            for(const alias of aliases) commands.set(String(alias).toLowerCase(), command);
        }catch(e){ console.error(`[COMMAND] Failed ${file}:`, e.message); }
    }
    console.log(`[COMMANDS] ${commands.size} commands available`);
}
loadCommands();
global.commands = commands;
global.etiasCommands = commands;
global.botConfig = { prefix: ".", features: { antidelete:true, antilink:true, antiviewonce:true, viewonce:true } };

// Make bot manager visible to deploy server
global.ETIAS_BOT_MANAGER = global.ETIAS_BOT_MANAGER || {
    sessions: new Map(),
    getSessions: function(){
        const list=[];
        for(const [phone, sess] of this.sessions.entries()){
            list.push({ sessionId: phone, phone, connected: sess.status==="open", status: sess.status });
        }
        return list;
    }
};

// ========== RESTORE MANY USERS ==========
async function restoreBots(){
    await connectMongo();

    let accounts=[];

    // 1. From local auth folder
    if(fs.existsSync(AUTH_DIR)){
        const entries = fs.readdirSync(AUTH_DIR, {withFileTypes:true});
        const local = entries.filter(e=>e.isDirectory()).map(e=>e.name).filter(p=>/^[0-9]+$/.test(p));
        accounts.push(...local);
    }

    // 2. From MongoDB - many users
    if(isMongo()){
        try{
            const mongoBots = await Bot.find({}).select('phone number');
            const authDocs = await AuthStore.find({}).select('phone');
            const mongoPhones = [...mongoBots.map(b=>b.phone||b.number), ...authDocs.map(a=>a.phone)].filter(Boolean);
            for(const p of mongoPhones){
                const clean = String(p).replace(/\D/g,'');
                if(clean && !accounts.includes(clean)) accounts.push(clean);
            }
            console.log(`[RESTORE] MongoDB has ${mongoPhones.length} saved users`);
        }catch(e){ console.error("[RESTORE] Mongo read failed:", e.message); }
    }

    accounts = [...new Set(accounts)];

    if(accounts.length===0){ console.log("[RESTORE] No saved WhatsApp accounts"); return; }

    console.log(`[RESTORE] ${accounts.length} account(s) found - connecting...`);

    for(const phone of accounts){
        try{
            console.log(`[RESTORE] → ${phone}...`);
            // Restore auth from Mongo if needed (for Render)
            await loadAuthFromMongo(phone);
            const sock = await createBot(phone);
            global.ETIAS_BOT_MANAGER.sessions.set(phone, { sock, phone, status: "connecting" });

            // Hook creds backup
            if(sock){
                sock.ev.on("creds.update", async ()=>{
                    setTimeout(()=> saveAuthToMongo(phone), 2000);
                });
            }

            console.log(`[RESTORE] ${phone} initialized`);
        }catch(e){ console.error(`[RESTORE] Failed ${phone}:`, e.message); }
        await new Promise(r=>setTimeout(r, 2500)); // delay for many users
    }

    // Periodic backup every 2 mins for many users
    if(isMongo()){
        setInterval(async()=>{
            for(const phone of accounts){
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

    // Start express only once
    try{ startServer(); }catch(e){ console.error("[SERVER] Failed:", e); }

    await restoreBots();

    console.log("[SYSTEM] ETIAS-MINI-BOT ready - supports many users");
}

start().catch(e=>console.error("[SYSTEM] Startup error:", e));

process.on("uncaughtException", e=>console.error("[UNCAUGHT]", e));
process.on("unhandledRejection", e=>console.error("[UNHANDLED]", e));
process.on("SIGINT", ()=>{ console.log("\n[SYSTEM] Shutting down..."); process.exit(0); });
process.on("SIGTERM", ()=>{ console.log("\n[SYSTEM] SIGTERM..."); process.exit(0); });

module.exports = { Bot, AuthStore, saveAuthToMongo, loadAuthFromMongo };
