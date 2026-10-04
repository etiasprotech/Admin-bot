"use strict";

const os = require("os");

module.exports.name = "ping";
module.exports.aliases = [
    "speed",
    "latency",
    "pong"
];

module.exports.execute = async (sock, msg, args) => {

    const chatId = msg?.key?.remoteJid;

    if (!chatId) {
        throw new Error("Chat ID not found.");
    }

    const start = Date.now();

    // ⚙️ Processing reaction
    try {
        await sock.sendMessage(chatId, {
            react: {
                text: "⚙️",
                key: msg.key
            }
        });
    } catch (error) {
        // Reaction failure should never stop ping
    }

    // Calculate bot information
    const uptimeSec = Math.floor(process.uptime());

    const hours = Math.floor(
        uptimeSec / 3600
    );

    const mins = Math.floor(
        (uptimeSec % 3600) / 60
    );

    const secs = uptimeSec % 60;

    const ramUsed = (
        process.memoryUsage().heapUsed /
        1024 /
        1024
    ).toFixed(2);

    const ramTotal = (
        os.totalmem() /
        1024 /
        1024 /
        1024
    ).toFixed(2);

    const cpuModel =
        os.cpus()?.[0]?.model
            ?.split("@")[0]
            ?.trim() ||
        "Unknown CPU";

    const latency =
        Date.now() - start;

    const text =
`╭━━━〔 *ETIAS-MINI-BOT PING* 〕━━━┈⊷
┃
┃ 🚀 *Speed:* ${latency} ms
┃ ⏱️ *Latency:* ${latency} ms
┃ ⏰ *Uptime:* ${hours}h ${mins}m ${secs}s
┃ 🧠 *RAM:* ${ramUsed} MB / ${ramTotal} GB
┃ 💻 *CPU:* ${cpuModel}
┃ 📡 *Platform:* ${os.platform()}
┃ 🤖 *Bot:* ETIAS-MINI-BOT V2 ULTRA
┃
╰━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*`;

    // Send final response directly
    await sock.sendMessage(
        chatId,
        {
            text
        },
        {
            quoted: msg
        }
    );

    // ⚡ Final reaction
    try {
        await sock.sendMessage(chatId, {
            react: {
                text: "⚡",
                key: msg.key
            }
        });
    } catch (error) {
        // Ignore reaction failure
    }

    console.log(
        `[PING] ${chatId} responded successfully`
    );
};
