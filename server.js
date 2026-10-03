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

/* ============================================================
   ETIAS-MINI-BOT
   FUTURISTIC PAIRING + MULTI ACCOUNT SERVER
============================================================ */

/* ============================================================
   EXPRESS
============================================================ */

const app = express();

const PORT =
    process.env.PORT || 3000;

/* ============================================================
   PATHS
============================================================ */

const AUTH_DIR =
    path.join(__dirname, "auth");

const DATABASE_DIR =
    path.join(__dirname, "database");

const MEDIA_DIR =
    path.join(__dirname, "media");

const ANTIDELETE_DB =
    path.join(
        DATABASE_DIR,
        "antidelete.json"
    );

const ANTILINK_DB =
    path.join(
        DATABASE_DIR,
        "antilink.json"
    );

const ANTIVIEWONCE_DB =
    path.join(
        DATABASE_DIR,
        "antiviewonce.json"
    );

const MESSAGE_STORE =
    path.join(
        DATABASE_DIR,
        "messageStore.json"
    );

/* ============================================================
   DIRECTORIES
============================================================ */

for (const dir of [
    AUTH_DIR,
    DATABASE_DIR,
    MEDIA_DIR
]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(
            dir,
            {
                recursive: true
            }
        );
    }
}

/* ============================================================
   JSON INITIALIZATION
============================================================ */

function ensureJSON(
    file,
    value = {}
) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(
            file,
            JSON.stringify(
                value,
                null,
                2
            )
        );
    }
}

ensureJSON(
    ANTIDELETE_DB
);

ensureJSON(
    ANTILINK_DB
);

ensureJSON(
    ANTIVIEWONCE_DB
);

ensureJSON(
    MESSAGE_STORE
);

/* ============================================================
   JSON HELPERS
============================================================ */

function readJSON(
    file,
    fallback = {}
) {
    try {
        return JSON.parse(
            fs.readFileSync(
                file,
                "utf8"
            )
        );
    } catch {
        return fallback;
    }
}

function writeJSON(
    file,
    data
) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(
                data,
                null,
                2
            )
        );
    } catch (error) {
        console.error(
            `[DATABASE] ${error.message}`
        );
    }
}

/* ============================================================
   DATABASE
============================================================ */

function getAntideleteDB() {
    return readJSON(
        ANTIDELETE_DB,
        {}
    );
}

function getAntilinkDB() {
    return readJSON(
        ANTILINK_DB,
        {}
    );
}

function getAntiviewonceDB() {
    return readJSON(
        ANTIVIEWONCE_DB,
        {}
    );
}

function getMessageStore() {
    return readJSON(
        MESSAGE_STORE,
        {}
    );
}

/* ============================================================
   ACTIVE SESSIONS
============================================================ */

const sessions =
    new Map();

/*
sessions:

phone => {
    sock,
    phone,
    status,
    pairingCode,
    reconnecting,
    startedAt
}
*/

/* ============================================================
   PHONE HELPERS
============================================================ */

function normalizePhone(
    phone
) {
    if (!phone) {
        return "";
    }

    return String(phone)
        .replace(/\D/g, "")
        .replace(/^00/, "");
}

function validatePhone(
    phone
) {
    const number =
        normalizePhone(phone);

    return (
        number.length >= 8 &&
        number.length <= 15
    );
}

function getAuthPath(
    phone
) {
    return path.join(
        AUTH_DIR,
        normalizePhone(phone)
    );
}

/* ============================================================
   MESSAGE HELPERS
============================================================ */

function getChatId(
    msg
) {
    return (
        msg?.key?.remoteJid ||
        ""
    );
}

function getSender(msg) {
    return (
        msg?.key?.participant ||
        msg?.key?.remoteJid ||
        ""
    );
}

function getMessageText(msg) {
    let message = msg?.message;

    if (!message) {
        return "";
    }

    if (message.ephemeralMessage?.message) {
        message = message.ephemeralMessage.message;
    }

    if (message.viewOnceMessage?.message) {
        message = message.viewOnceMessage.message;
    }

    if (message.viewOnceMessageV2?.message) {
        message = message.viewOnceMessageV2.message;
    }

    if (message.viewOnceMessageV2Extension?.message) {
        message = message.viewOnceMessageV2Extension.message;
    }

    if (message.documentWithCaptionMessage?.message) {
        message = message.documentWithCaptionMessage.message;
    }

    if (message.editedMessage?.message) {
        message = message.editedMessage.message;
    }

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedButtonId ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.templateButtonReplyMessage?.selectedId ||
        message.interactiveResponseMessage?.body?.text ||
        message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        ""
    );
}

function getMessageType(message) {
    if (!message) {
        return "unknown";
    }

    return (
        Object.keys(message)[0] ||
        "unknown"
    );
}

function getMessageType(
    message
) {
    if (!message) {
        return "unknown";
    }

    return (
        Object.keys(message)[0] ||
        "unknown"
    );
}

function getMessageContent(
    message
) {
    if (!message) {
        return "";
    }

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        ""
    );
}

/* ============================================================
   LINK REGEX
============================================================ */

const LINK_REGEX =
    /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/|instagram\.com\/|facebook\.com\/|youtube\.com\/|youtu\.be\/)/i;

/* ============================================================
   MESSAGE STORE
============================================================ */

function saveIncomingMessage(
    msg
) {
    try {

        if (!msg?.message) {
            return;
        }

        if (msg.key?.fromMe) {
    console.log(
        `[${phone}] 🤖 Processing own message.`
    );
}

        /*
         * Don't store protocol delete
         * messages as replacements.
         */
        if (
            msg.message
                ?.protocolMessage
        ) {
            return;
        }

        const id =
            msg.key?.id;

        if (!id) {
            return;
        }

        const store =
            getMessageStore();

        store[id] = {
            chatId:
                msg.key.remoteJid,

            sender:
                msg.key.participant ||
                msg.key.remoteJid,

            content:
                getMessageContent(
                    msg.message
                ),

            message:
                msg.message,

            timestamp:
                Date.now(),

            type:
                getMessageType(
                    msg.message
                )
        };

        /*
         * Keep maximum 500 messages.
         */
        const keys =
            Object.keys(store);

        if (keys.length > 500) {

            keys.sort(
                (a, b) =>
                    store[a].timestamp -
                    store[b].timestamp
            );

            const removeCount =
                keys.length - 500;

            for (
                let i = 0;
                i < removeCount;
                i++
            ) {
                delete store[
                    keys[i]
                ];
            }
        }

        writeJSON(
            MESSAGE_STORE,
            store
        );

    } catch (error) {

        console.error(
            "[MESSAGE STORE]",
            error.message
        );

    }
}

/* ============================================================
   GROUP INFORMATION
============================================================ */

async function getGroupInfo(
    sock,
    chatId,
    sender
) {
    try {

        if (
            !chatId.endsWith(
                "@g.us"
            )
        ) {
            return {
                isGroup: false,
                isAdmin: false,
                isBotAdmin: false,
                metadata: null
            };
        }

        const metadata =
            await sock.groupMetadata(
                chatId
            );

        const participant =
            metadata.participants.find(
                p =>
                    p.id === sender
            );

        const botId =
            sock.user?.id
                ?.split(":")[0];

        const botJid =
            botId
                ? `${botId}@s.whatsapp.net`
                : "";

        const botParticipant =
            metadata.participants.find(
                p =>
                    p.id === botJid
            );

        return {
            isGroup: true,

            isAdmin:
                participant?.admin ===
                    "admin" ||
                participant?.admin ===
                    "superadmin",

            isBotAdmin:
                botParticipant?.admin ===
                    "admin" ||
                botParticipant?.admin ===
                    "superadmin",

            metadata
        };

    } catch {

        return {
            isGroup: true,
            isAdmin: false,
            isBotAdmin: false,
            metadata: null
        };

    }
}

/* ============================================================
   VIEW ONCE EXTRACTION
============================================================ */

function extractViewOnce(
    message
) {
    if (!message) {
        return null;
    }

    if (
        message
            .viewOnceMessage
            ?.message
    ) {
        return {
            message:
                message
                    .viewOnceMessage
                    .message
        };
    }

    if (
        message
            .viewOnceMessageV2
            ?.message
    ) {
        return {
            message:
                message
                    .viewOnceMessageV2
                    .message
        };
    }

    if (
        message
            .viewOnceMessageV2Extension
            ?.message
    ) {
        return {
            message:
                message
                    .viewOnceMessageV2Extension
                    .message
        };
    }

    return null;
}

/* ============================================================
   ANTIVIEWONCE
============================================================ */

async function handleAntiViewOnce(
    sock,
    msg,
    phone
) {
    try {

        if (!msg?.message) {
            return;
        }

        if (msg.key?.fromMe) {
            return;
        }

        const chatId =
            msg.key.remoteJid;

        if (!chatId) {
            return;
        }

        const db =
            getAntiviewonceDB();

        if (!db[chatId]) {
            return;
        }

        const extracted =
            extractViewOnce(
                msg.message
            );

        if (!extracted) {
            return;
        }

        const inner =
            extracted.message;

        const innerType =
            Object.keys(inner)[0];

        if (!innerType) {
            return;
        }

        const media =
            inner[innerType];

        if (!media) {
            return;
        }

        let type;

        if (
            innerType ===
            "imageMessage"
        ) {
            type = "image";
        } else if (
            innerType ===
            "videoMessage"
        ) {
            type = "video";
        } else if (
            innerType ===
            "audioMessage"
        ) {
            type = "audio";
        } else {
            return;
        }

        const sender =
            getSender(msg);

        console.log(
            `[${phone}] 👁️ View-once detected`
        );

        let buffer =
            Buffer.alloc(0);

        const stream =
            await downloadContentFromMessage(
                media,
                type
            );

        for await (
            const chunk of stream
        ) {
            buffer =
                Buffer.concat([
                    buffer,
                    chunk
                ]);
        }

        if (!buffer.length) {
            throw new Error(
                "Empty media buffer"
            );
        }

        const mention =
            sender
                ? `@${sender.split("@")[0]}`
                : "Unknown";

        await sock.sendMessage(
            chatId,
            {
                text:
                    `╭━━━〔 *ANTIVIEWONCE* 〕━━━\n` +
                    `┃ 👤 Sender: ${mention}\n` +
                    `┃ 📎 Type: ${type.toUpperCase()}\n` +
                    `┃ 👁️ View-once recovered\n` +
                    `╰━━━━━━━━━━━━━━━━━━\n\n` +
                    `> *POWERED BY ETIAS-TECH*`,

                mentions:
                    sender
                        ? [sender]
                        : []
            }
        );

        if (
            type === "image"
        ) {

            await sock.sendMessage(
                chatId,
                {
                    image: buffer,

                    caption:
                        media.caption ||
                        "👁️ View-once image recovered\n\n> POWERED BY ETIAS-TECH"
                }
            );

        } else if (
            type === "video"
        ) {

            await sock.sendMessage(
                chatId,
                {
                    video: buffer,

                    caption:
                        media.caption ||
                        "👁️ View-once video recovered\n\n> POWERED BY ETIAS-TECH",

                    mimetype:
                        media.mimetype ||
                        "video/mp4"
                }
            );

        } else if (
            type === "audio"
        ) {

            await sock.sendMessage(
                chatId,
                {
                    audio: buffer,

                    mimetype:
                        media.mimetype ||
                        "audio/mp4",

                    ptt:
                        media.ptt ||
                        false
                }
            );

        }

        console.log(
            `[${phone}] ✅ View-once recovered`
        );

    } catch (error) {

        console.error(
            `[${phone}] [ANTIVIEWONCE]`,
            error.message
        );

    }
}

/* ============================================================
   ANTILINK
============================================================ */

async function handleAntiLink(
    sock,
    msg,
    phone
) {
    try {

        if (!msg?.message) {
            return;
        }

        if (msg.key?.fromMe) {
            return;
        }

        const chatId =
            msg.key.remoteJid;

        if (
            !chatId ||
            !chatId.endsWith(
                "@g.us"
            )
        ) {
            return;
        }

        const db =
            getAntilinkDB();

        const config =
            db[chatId];

        if (
            !config ||
            !config.enabled
        ) {
            return;
        }

        const text =
            getMessageText(msg);

        if (!text) {
            return;
        }

        if (
            !LINK_REGEX.test(text)
        ) {
            return;
        }

        const sender =
            getSender(msg);

        const group =
            await getGroupInfo(
                sock,
                chatId,
                sender
            );

        /*
         * Group admins are allowed.
         */
        if (
            group.isAdmin
        ) {
            return;
        }

        /*
         * Bot needs admin for deletion/kick.
         */
        if (
            !group.isBotAdmin
        ) {

            console.log(
                `[${phone}] ⚠️ Bot is not admin in ${chatId}`
            );

            return;
        }

        /*
         * Allow current group invite link.
         */
        try {

            const inviteCode =
                await sock.groupInviteCode(
                    chatId
                );

            if (
                inviteCode &&
                text.includes(
                    inviteCode
                )
            ) {
                return;
            }

        } catch {}

        /*
         * Delete original.
         */
        try {

            await sock.sendMessage(
                chatId,
                {
                    delete:
                        msg.key
                }
            );

        } catch (error) {

            console.log(
                `[${phone}] Link delete failed:`,
                error.message
            );

        }

        const action =
            config.action ||
            "delete";

        /*
         * DELETE
         */
        if (
            action === "delete"
        ) {

            await sock.sendMessage(
                chatId,
                {
                    text:
                        `⚠️ @${sender.split("@")[0]} Links are not allowed!\n\n` +
                        `> *POWERED BY ETIAS-TECH*`,

                    mentions: [
                        sender
                    ]
                }
            );

            return;
        }

        /*
         * WARN
         */
        if (
            action === "warn"
        ) {

            config.warnCount =
                config.warnCount ||
                {};

            config.warnCount[
                sender
            ] =
                (
                    config.warnCount[
                        sender
                    ] || 0
                ) + 1;

            const warnings =
                config.warnCount[
                    sender
                ];

            if (
                warnings >= 3
            ) {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            `🔨 @${sender.split("@")[0]} kicked after 3 link warnings!\n\n` +
                            `> *POWERED BY ETIAS-TECH*`,

                        mentions: [
                            sender
                        ]
                    }
                );

                try {

                    await sock.groupParticipantsUpdate(
                        chatId,
                        [sender],
                        "remove"
                    );

                } catch (error) {

                    console.log(
                        `[${phone}] Kick failed:`,
                        error.message
                    );

                }

                config.warnCount[
                    sender
                ] = 0;

            } else {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            `⚠️ @${sender.split("@")[0]} Warning ${warnings}/3\n\n` +
                            `Links are not allowed!`,

                        mentions: [
                            sender
                        ]
                    }
                );

            }

            writeJSON(
                ANTILINK_DB,
                db
            );

            return;
        }

        /*
         * KICK
         */
        if (
            action === "kick"
        ) {

            await sock.sendMessage(
                chatId,
                {
                    text:
                        `🔨 @${sender.split("@")[0]} kicked for sending a link!\n\n` +
                        `> *POWERED BY ETIAS-TECH*`,

                    mentions: [
                        sender
                    ]
                }
            );

            try {

                await sock.groupParticipantsUpdate(
                    chatId,
                    [sender],
                    "remove"
                );

            } catch (error) {

                console.log(
                    `[${phone}] Kick failed:`,
                    error.message
                );

            }

        }

    } catch (error) {

        console.error(
            `[${phone}] [ANTILINK]`,
            error.message
        );

    }
}

/* ============================================================
   ANTIDELETE
============================================================ */

async function handleAntiDelete(
    sock,
    msg,
    phone
) {
    try {

        const protocol =
            msg?.message
                ?.protocolMessage;

        if (!protocol) {
            return;
        }

        /*
         * REVOKE
         */
        if (
            protocol.type !== 0
        ) {
            return;
        }

        const deletedKey =
            protocol.key;

        if (
            !deletedKey?.id
        ) {
            return;
        }

        const chatId =
            deletedKey.remoteJid ||
            msg.key.remoteJid;

        if (!chatId) {
            return;
        }

        const db =
            getAntideleteDB();

        if (!db[chatId]) {
            return;
        }

        const store =
            getMessageStore();

        const saved =
            store[
                deletedKey.id
            ];

        if (!saved) {

            console.log(
                `[${phone}] ⚠️ Deleted message not found: ${deletedKey.id}`
            );

            return;
        }

        const sender =
            saved.sender ||
            chatId;

        const mention =
            `@${sender.split("@")[0]}`;

        await sock.sendMessage(
            chatId,
            {
                text:
                    `╭━━━〔 *ANTIDELETE* 〕━━━\n` +
                    `┃ 🗑️ Deleted message recovered\n` +
                    `┃ 👤 Sender: ${mention}\n` +
                    `┃ 📎 Type: ${saved.type}\n` +
                    `╰━━━━━━━━━━━━━━━━━━\n\n` +
                    `> *POWERED BY ETIAS-TECH*`,

                mentions: [
                    sender
                ]
            }
        );

        /*
         * TEXT
         */
        if (
            saved.type ===
                "conversation" ||
            saved.type ===
                "extendedTextMessage"
        ) {

            if (
                saved.content
            ) {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            `💬 *Deleted message:*\n\n` +
                            `${saved.content}\n\n` +
                            `> *POWERED BY ETIAS-TECH*`
                    }
                );

            }

            return;
        }

        /*
         * IMAGE
         */
        if (
            saved.message
                ?.imageMessage
        ) {

            try {

                const media =
                    saved.message
                        .imageMessage;

                const stream =
                    await downloadContentFromMessage(
                        media,
                        "image"
                    );

                let buffer =
                    Buffer.alloc(0);

                for await (
                    const chunk of stream
                ) {

                    buffer =
                        Buffer.concat([
                            buffer,
                            chunk
                        ]);

                }

                await sock.sendMessage(
                    chatId,
                    {
                        image:
                            buffer,

                        caption:
                            media.caption ||
                            "🗑️ Deleted image recovered\n\n> POWERED BY ETIAS-TECH"
                    }
                );

            } catch {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            "📷 Deleted image detected, but media could not be recovered."
                    }
                );

            }

            return;
        }

        /*
         * VIDEO
         */
        if (
            saved.message
                ?.videoMessage
        ) {

            try {

                const media =
                    saved.message
                        .videoMessage;

                const stream =
                    await downloadContentFromMessage(
                        media,
                        "video"
                    );

                let buffer =
                    Buffer.alloc(0);

                for await (
                    const chunk of stream
                ) {

                    buffer =
                        Buffer.concat([
                            buffer,
                            chunk
                        ]);

                }

                await sock.sendMessage(
                    chatId,
                    {
                        video:
                            buffer,

                        caption:
                            media.caption ||
                            "🗑️ Deleted video recovered\n\n> POWERED BY ETIAS-TECH",

                        mimetype:
                            media.mimetype ||
                            "video/mp4"
                    }
                );

            } catch {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            "🎥 Deleted video detected, but media could not be recovered."
                    }
                );

            }

            return;
        }

        /*
         * AUDIO
         */
        if (
            saved.message
                ?.audioMessage
        ) {

            try {

                const media =
                    saved.message
                        .audioMessage;

                const stream =
                    await downloadContentFromMessage(
                        media,
                        "audio"
                    );

                let buffer =
                    Buffer.alloc(0);

                for await (
                    const chunk of stream
                ) {

                    buffer =
                        Buffer.concat([
                            buffer,
                            chunk
                        ]);

                }

                await sock.sendMessage(
                    chatId,
                    {
                        audio:
                            buffer,

                        mimetype:
                            media.mimetype ||
                            "audio/mp4",

                        ptt:
                            media.ptt ||
                            false
                    }
                );

            } catch {

                await sock.sendMessage(
                    chatId,
                    {
                        text:
                            "🎵 Deleted audio detected, but media could not be recovered."
                    }
                );

            }

            return;
        }

        /*
         * FALLBACK
         */
        await sock.sendMessage(
            chatId,
            {
                text:
                    `📎 Deleted ${saved.type} detected.\n\n` +
                    `Content: ${saved.content || "[media]"}`
            }
        );

    } catch (error) {

        console.error(
            `[${phone}] [ANTIDELETE]`,
            error.message
        );

    }
}

/* ============================================================
   AUTOMATIC FEATURE PIPELINE
============================================================ */

async function processMessageFeatures(
    sock,
    msg,
    phone
) {

    try {

        /*
         * Store normal messages first.
         */
        saveIncomingMessage(
            msg
        );

        /*
         * Deleted message detection.
         */
        await handleAntiDelete(
            sock,
            msg,
            phone
        );

        /*
         * View-once detection.
         */
        await handleAntiViewOnce(
            sock,
            msg,
            phone
        );

        /*
         * Link protection.
         */
        await handleAntiLink(
            sock,
            msg,
            phone
        );

    } catch (error) {

        console.error(
            `[${phone}] Feature pipeline error:`,
            error.message
        );

    }
}

/* ============================================================
   COMMAND HANDLER
============================================================ */

function attachMessageHandler(sock, phone) {

    if (sock.__ETIAS_MESSAGE_HANDLER) {
        console.log(`[${phone}] ℹ️ Message handler already attached.`);
        return;
    }

    sock.__ETIAS_MESSAGE_HANDLER = true;

    console.log(`[${phone}] 🧩 Message handler attached.`);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        try {

            console.log(
                `[${phone}] 🔥 messages.upsert type=${type} count=${messages?.length || 0}`
            );

            if (!Array.isArray(messages)) {
                return;
            }

            for (const msg of messages) {

                try {

                    if (!msg) {
                        continue;
                    }

                    /*
                     * ========================================================
                     * BASIC MESSAGE INFORMATION
                     * ========================================================
                     */

                    const fromMe = Boolean(msg.key?.fromMe);

                    const chatId = getChatId(msg);

                    if (!chatId) {
                        continue;
                    }

                    if (chatId === "status@broadcast") {
                        continue;
                    }

                    /*
                     * Ignore protocol/receipt messages.
                     *
                     * WhatsApp generates many fromMe events that contain
                     * no actual message. They must NOT be treated as commands.
                     */

                    if (
                        !msg.message ||
                        typeof msg.message !== "object" ||
                        Object.keys(msg.message).length === 0
                    ) {
                        if (fromMe) {
                            console.log(
                                `[${phone}] ℹ️ Ignoring empty own-message event.`
                            );
                        }

                        continue;
                    }

                    /*
                     * ========================================================
                     * EXTRACT MESSAGE TEXT
                     * ========================================================
                     */

                    const text = String(
                        getMessageText(msg) || ""
                    ).trim();

                    const sender = getSender(msg);

                    /*
                     * ========================================================
                     * LOG REAL MESSAGES
                     * ========================================================
                     */

                    console.log("");
                    console.log(
                        `[${phone}] 📩 MESSAGE RECEIVED`
                    );
                    console.log(
                        `[${phone}] From: ${sender}`
                    );
                    console.log(
                        `[${phone}] Chat: ${chatId}`
                    );
                    console.log(
                        `[${phone}] FromMe: ${fromMe}`
                    );
                    console.log(
                        `[${phone}] Type: ${getMessageType(msg.message)}`
                    );
                    console.log(
                        `[${phone}] Text: ${text || "(no text)"}`
                    );

                    /*
                     * ========================================================
                     * COMMAND PROCESSING
                     * ========================================================
                     *
                     * IMPORTANT:
                     * fromMe messages ARE allowed.
                     *
                     * This means sending:
                     *
                     * .menu
                     *
                     * from the bot's own WhatsApp account can execute
                     * the command.
                     */

                    if (text) {

                        const prefix =
                            global.botConfig?.prefix || ".";

                        if (text.startsWith(prefix)) {

                            const body = text
                                .slice(prefix.length)
                                .trim();

                            if (body) {

                                const parts =
                                    body.split(/\s+/);

                                const commandName =
                                    String(
                                        parts.shift() || ""
                                    ).toLowerCase();

                                const args = parts;

                                console.log(
                                    `[${phone}] 🔎 Command detected: .${commandName}`
                                );

                                /*
                                 * =================================================
                                 * COMMAND MAP
                                 * =================================================
                                 */

                                const commandMap =
                                    global.commands;

                                if (!commandMap) {

                                    console.error(
                                        `[${phone}] ❌ global.commands unavailable`
                                    );

                                } else {

                                    const command =
                                        commandMap.get(commandName);

                                    if (!command) {

                                        console.log(
                                            `[${phone}] ⚠️ Unknown command: .${commandName}`
                                        );

                                    } else if (
                                        typeof command.execute !==
                                        "function"
                                    ) {

                                        console.error(
                                            `[${phone}] ❌ .${commandName} has no execute()`
                                        );

                                    } else {

                                        console.log("");
                                        console.log(
                                            `[${phone}] ⚡ EXECUTING COMMAND`
                                        );
                                        console.log(
                                            `[${phone}] Command: .${commandName}`
                                        );
                                        console.log(
                                            `[${phone}] Arguments:`,
                                            args
                                        );
                                        console.log(
                                            `[${phone}] FromMe: ${fromMe}`
                                        );

                                        try {

                                            await command.execute(
                                                sock,
                                                msg,
                                                args
                                            );

                                            console.log(
                                                `[${phone}] ✅ .${commandName} completed`
                                            );

                                        } catch (commandError) {

                                            console.error(
                                                `[${phone}] ❌ .${commandName} ERROR:`,
                                                commandError
                                            );

                                            try {

                                                await sock.sendMessage(
                                                    chatId,
                                                    {
                                                        text:
                                                            `❌ Command error:\n\n` +
                                                            `${commandError?.message || commandError}\n\n` +
                                                            `> *POWERED BY ETIAS-TECH*`
                                                    },
                                                    {
                                                        quoted: msg
                                                    }
                                                );

                                            } catch (sendError) {

                                                console.error(
                                                    `[${phone}] ❌ Failed to send command error:`,
                                                    sendError
                                                );

                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    /*
                     * ========================================================
                     * AUTOMATIC FEATURES
                     * ========================================================
                     *
                     * Do NOT run automatic features on fromMe messages.
                     *
                     * This prevents:
                     *
                     * .menu
                     *
                     * from triggering antilink/antidelete/etc. against
                     * the bot's own outgoing message.
                     */

                    if (!fromMe) {

                        try {

                            await processMessageFeatures(
                                sock,
                                msg,
                                phone
                            );

                        } catch (featureError) {

                            console.error(
                                `[${phone}] ❌ Message feature error:`,
                                featureError
                            );

                        }
                    }

                } catch (messageError) {

                    console.error(
                        `[${phone}] ❌ Individual message error:`,
                        messageError
                    );

                }
            }

        } catch (error) {

            console.error(
                `[${phone}] ❌ MESSAGES.UPSERT ERROR:`,
                error
            );

        }

    });
}


/* ============================================================
   CREATE WHATSAPP BOT
============================================================ */

async function createBot(
    phone
) {

    phone =
        normalizePhone(
            phone
        );

    if (
        !validatePhone(
            phone
        )
    ) {
        throw new Error(
            "Invalid phone number"
        );
    }

    /*
     * Don't create duplicate sockets.
     */
    const existing =
        sessions.get(
            phone
        );

    if (
        existing?.sock &&
        existing.status !==
            "closed"
    ) {

        console.log(
            `[${phone}] ℹ️ Existing session found.`
        );

        return existing.sock;
    }

    const authPath =
        getAuthPath(
            phone
        );

    if (
        !fs.existsSync(
            authPath
        )
    ) {

        fs.mkdirSync(
            authPath,
            {
                recursive: true
            }
        );

    }

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            authPath
        );

    let version;

    try {

        const latest =
            await fetchLatestBaileysVersion();

        version =
            latest.version;

        console.log(
            `[${phone}] WhatsApp Web version: ${version.join(".")}`
        );

        console.log(
            `[${phone}] WA version latest: ${latest.isLatest}`
        );

    } catch {

        version = [
            2,
            3000,
            1015901307
        ];

    }

    const logger =
        pino({
            level:
                process.env.BAILEYS_LOG_LEVEL ||
                "silent"
        });

    console.log(
        `[${phone}] 🚀 Creating WhatsApp socket...`
    );

    const sock =
        makeWASocket({

            version,

            logger,

            printQRInTerminal:
                false,

            auth: {
                creds:
                    state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
            },

            markOnlineOnConnect:
                false,

            generateHighQualityLinkPreview:
                false,

            syncFullHistory:
                false,

            getMessage:
                async key => {

                    try {

                        const store =
                            getMessageStore();

                        return (
                            store[
                                key.id
                            ]?.message ||
                            undefined
                        );

                    } catch {

                        return undefined;

                    }

                }

        });

    const session = {

        sock,

        phone,

        status:
            "connecting",

        pairingCode:
            null,

        reconnecting:
            false,

        startedAt:
            Date.now()

    };

    sessions.set(
        phone,
        session
    );

    /*
     * Commands + automatic features.
     */
    attachMessageHandler(
        sock,
        phone
    );

    /*
     * Credentials.
     */
    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /* ========================================================
       CONNECTION UPDATE
    ======================================================== */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (
                connection ===
                "connecting"
            ) {

                session.status =
                    "connecting";

                console.log(
                    `[${phone}] 🔄 WhatsApp socket connecting...`
                );

            }

            if (
                connection ===
                "open"
            ) {

                session.status =
                    "open";

                session.reconnecting =
                    false;

                session.pairingCode =
                    null;

                console.log("");

                console.log(
                    "╔══════════════════════════════════════════════════════════════╗"
                );

                console.log(
                    "║       ETIAS-MINI-BOT CONNECTED                              ║"
                );

                console.log(
                    "╠══════════════════════════════════════════════════════════════╣"
                );

                console.log(
                    `║ Phone: ${phone}`
                );

                console.log(
                    "║ Status: ONLINE"
                );

                console.log(
                    "║ Pairing: COMPLETE"
                );

                console.log(
                    "╚══════════════════════════════════════════════════════════════╝"
                );

                console.log("");

            }

            if (
                connection ===
                "close"
            ) {

                session.status =
                    "closed";

                let code;

                try {

                    code =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                } catch {

                    code =
                        undefined;

                }

                const message =
                    lastDisconnect
                        ?.error
                        ?.message ||
                    "Unknown";

                const shouldReconnect =
                    code !==
                    DisconnectReason.loggedOut;

                console.log("");

                console.log(
                    `[${phone}] ❌ WHATSAPP CONNECTION CLOSED`
                );

                console.log(
                    `[${phone}] Disconnect code: ${code}`
                );

                console.log(
                    `[${phone}] Message: ${message}`
                );

                console.log(
                    `[${phone}] Reconnect: ${shouldReconnect}`
                );

                /*
                 * Logged out.
                 */
                if (
                    !shouldReconnect
                ) {

                    console.log(
                        `[${phone}] 🔴 WhatsApp logged out.`
                    );

                    sessions.delete(
                        phone
                    );

                    return;
                }

                /*
                 * Prevent duplicate
                 * reconnect timers.
                 */
                if (
                    session.reconnecting
                ) {
                    return;
                }

                session.reconnecting =
                    true;

                console.log(
                    `[${phone}] 🔄 Reconnecting in 10s...`
                );

                setTimeout(
                    async () => {

                        try {

                            sessions.delete(
                                phone
                            );

                            await createBot(
                                phone
                            );

                        } catch (
                            reconnectError
                        ) {

                            console.error(
                                `[${phone}] Reconnect failed:`,
                                reconnectError.message
                            );

                        }

                    },
                    10000
                );

            }

        }
    );

    /* ========================================================
       PHONE NUMBER PAIRING
    ======================================================== */

    if (
        !state.creds.registered
    ) {

        /*
         * Small delay allows the socket to initialize
         * before requesting the pairing code.
         */
        setTimeout(
            async () => {

                try {

                    console.log(
                        `[${phone}] 📲 Requesting WhatsApp pairing code...`
                    );

                    const code =
                        await sock.requestPairingCode(
                            phone
                        );

                    session.pairingCode =
                        code;

                    console.log("");

                    console.log(
                        "╔══════════════════════════════════════════╗"
                    );

                    console.log(
                        "║       WHATSAPP PAIRING CODE             ║"
                    );

                    console.log(
                        "╠══════════════════════════════════════════╣"
                    );

                    console.log(
                        `║ Phone: ${phone}`
                    );

                    console.log(
                        `║ Code:  ${code}`
                    );

                    console.log(
                        "╠══════════════════════════════════════════╣"
                    );

                    console.log(
                        "║ WhatsApp → Linked Devices               ║"
                    );

                    console.log(
                        "║ → Link a device                          ║"
                    );

                    console.log(
                        "║ → Link with phone number instead        ║"
                    );

                    console.log(
                        "╚══════════════════════════════════════════╝"
                    );

                    console.log("");

                } catch (error) {

                    console.error(
                        `[${phone}] ❌ Pairing code failed:`,
                        error.message
                    );

                }

            },
            1500
        );

    } else {

        console.log(
            `[${phone}] 🔐 Saved WhatsApp credentials found.`
        );

    }

    return sock;
}

/* ============================================================
   EXPRESS MIDDLEWARE
============================================================ */

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

/* ============================================================
   FUTURISTIC HOME / PAIRING UI
============================================================ */

app.get(
    "/",
    (req, res) => {

        res.send(`<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>ETIAS-MINI-BOT | Pairing</title>

<style>

*{
    box-sizing:border-box;
    margin:0;
    padding:0;
}

html,
body{
    min-height:100%;
}

body{

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    background:
        radial-gradient(
            circle at 50% 0%,
            #073d2c 0%,
            #02140f 28%,
            #020504 60%,
            #000000 100%
        );

    color:#ffffff;

    overflow-x:hidden;
}

/* =========================================================
   BACKGROUND
========================================================= */

body::before{

    content:"";

    position:fixed;

    inset:0;

    pointer-events:none;

    background:
        linear-gradient(
            rgba(0,255,170,.025) 1px,
            transparent 1px
        ),
        linear-gradient(
            90deg,
            rgba(0,255,170,.025) 1px,
            transparent 1px
        );

    background-size:
        35px 35px;

    mask-image:
        linear-gradient(
            to bottom,
            black,
            transparent
        );
}

.scanline{

    position:fixed;

    left:0;

    width:100%;

    height:2px;

    background:
        rgba(
            0,
            255,
            170,
            .2
        );

    box-shadow:
        0 0 20px
        rgba(
            0,
            255,
            170,
            .3
        );

    animation:
        scan 7s
        linear
        infinite;

    pointer-events:none;

    z-index:20;
}

@keyframes scan{

    0%{
        top:-5px;
    }

    100%{
        top:100%;
    }

}

/* =========================================================
   HEADER
========================================================= */

.header{

    width:100%;

    padding:
        22px
        20px
        10px;

    text-align:center;
}

.logo{

    font-size:
        clamp(
            28px,
            8vw,
            52px
        );

    font-weight:
        900;

    letter-spacing:
        3px;

    color:
        #00ffae;

    text-shadow:
        0 0 8px
        rgba(0,255,174,.9),

        0 0 25px
        rgba(0,255,174,.5),

        0 0 55px
        rgba(0,255,174,.2);
}

.subtitle{

    margin-top:8px;

    color:#86ffe0;

    font-size:
        13px;

    letter-spacing:
        3px;

    text-transform:
        uppercase;
}

/* =========================================================
   MAIN
========================================================= */

.container{

    width:
        min(
            94%,
            580px
        );

    margin:
        30px
        auto
        70px;
}

/* =========================================================
   CARD
========================================================= */

.card{

    position:relative;

    padding:
        28px;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .55
        );

    border-radius:
        24px;

    background:
        linear-gradient(
            145deg,
            rgba(0,255,174,.07),
            rgba(0,0,0,.78)
        );

    backdrop-filter:
        blur(18px);

    box-shadow:
        0 0 35px
        rgba(
            0,
            255,
            174,
            .10
        ),
        inset 0 0 35px
        rgba(
            0,
            255,
            174,
            .025
        );

    overflow:hidden;
}

.card::before{

    content:"";

    position:absolute;

    top:0;
    left:15%;

    width:70%;
    height:1px;

    background:
        #00ffae;

    box-shadow:
        0 0 20px
        #00ffae;
}

/* =========================================================
   STATUS
========================================================= */

.status{

    display:flex;

    align-items:center;

    gap:10px;

    padding:
        12px
        15px;

    margin-bottom:
        25px;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .18
        );

    border-radius:
        14px;

    background:
        rgba(
            0,
            255,
            174,
            .04
        );

    color:#baffed;

    font-size:
        14px;
}

.status-dot{

    width:10px;
    height:10px;

    border-radius:
        50%;

    background:
        #00ffae;

    box-shadow:
        0 0 12px
        #00ffae;

    animation:
        pulse 1.5s
        infinite;
}

@keyframes pulse{

    0%,100%{
        opacity:1;
        transform:scale(1);
    }

    50%{
        opacity:.45;
        transform:scale(.75);
    }

}

/* =========================================================
   TITLE
========================================================= */

.section-title{

    font-size:
        21px;

    font-weight:
        800;

    margin-bottom:
        8px;

    color:
        #ffffff;
}

.description{

    color:
        #91aaa4;

    font-size:
        14px;

    line-height:
        1.6;

    margin-bottom:
        22px;
}

/* =========================================================
   INPUT
========================================================= */

.label{

    display:block;

    color:
        #a5fff0;

    font-size:
        12px;

    font-weight:
        700;

    letter-spacing:
        1.5px;

    text-transform:
        uppercase;

    margin-bottom:
        9px;
}

.input-wrap{

    display:flex;

    align-items:center;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .35
        );

    border-radius:
        14px;

    background:
        rgba(
            0,
            0,
            0,
            .45
        );

    overflow:hidden;

    transition:
        .25s;
}

.input-wrap:focus-within{

    border-color:
        #00ffae;

    box-shadow:
        0 0 20px
        rgba(
            0,
            255,
            174,
            .13
        );
}

.prefix{

    padding-left:
        16px;

    color:
        #00ffae;

    font-weight:
        700;

    font-size:
        15px;
}

input{

    width:100%;

    padding:
        16px;

    border:0;

    outline:0;

    background:
        transparent;

    color:
        #ffffff;

    font-size:
        16px;
}

input::placeholder{

    color:
        #4f6660;
}

/* =========================================================
   BUTTON
========================================================= */

.generate{

    width:100%;

    margin-top:
        15px;

    padding:
        16px;

    border:0;

    border-radius:
        14px;

    background:
        linear-gradient(
            90deg,
            #00d98d,
            #00ffae,
            #00d98d
        );

    background-size:
        200% 100%;

    color:
        #00140e;

    font-size:
        15px;

    font-weight:
        900;

    letter-spacing:
        1px;

    cursor:pointer;

    box-shadow:
        0 0 20px
        rgba(
            0,
            255,
            174,
            .18
        );

    transition:
        .25s;
}

.generate:hover{

    background-position:
        100% 0;

    transform:
        translateY(-1px);

    box-shadow:
        0 0 30px
        rgba(
            0,
            255,
            174,
            .3
        );
}

.generate:disabled{

    opacity:
        .5;

    cursor:
        wait;

    transform:
        none;
}

/* =========================================================
   PAIRING RESULT
========================================================= */

.result{

    display:none;

    margin-top:
        25px;

    padding:
        20px;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .3
        );

    border-radius:
        18px;

    background:
        rgba(
            0,
            255,
            174,
            .035
        );
}

.result.show{
    display:block;
}

.result-title{

    color:
        #91aaa4;

    font-size:
        11px;

    text-transform:
        uppercase;

    letter-spacing:
        2px;

    margin-bottom:
        12px;
}

.code{

    display:block;

    text-align:center;

    padding:
        17px
        10px;

    border-radius:
        13px;

    background:
        #000b08;

    border:
        1px solid
        #00ffae;

    color:
        #00ffae;

    font-size:
        30px;

    font-weight:
        900;

    letter-spacing:
        7px;

    text-shadow:
        0 0 15px
        rgba(
            0,
            255,
            174,
            .7
        );

    word-break:
        break-all;
}

.copy{

    width:100%;

    margin-top:
        10px;

    padding:
        12px;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .35
        );

    border-radius:
        11px;

    background:
        rgba(
            0,
            255,
            174,
            .06
        );

    color:
        #9effe9;

    cursor:pointer;

    font-weight:
        700;
}

/* =========================================================
   INSTRUCTIONS
========================================================= */

.instructions{

    margin-top:
        25px;
}

.step{

    display:flex;

    gap:12px;

    padding:
        13px
        0;

    border-bottom:
        1px solid
        rgba(
            255,
            255,
            255,
            .05
        );

    color:
        #c6d8d4;

    font-size:
        14px;

    line-height:
        1.5;
}

.step-number{

    flex:
        0 0 28px;

    width:28px;
    height:28px;

    display:flex;

    align-items:center;
    justify-content:center;

    border-radius:
        50%;

    background:
        rgba(
            0,
            255,
            174,
            .09
        );

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .35
        );

    color:
        #00ffae;

    font-weight:
        900;
}

/* =========================================================
   ACCOUNT STATUS
========================================================= */

.account-status{

    margin-top:
        20px;

    padding:
        15px;

    border-radius:
        14px;

    background:
        rgba(
            255,
            255,
            255,
            .025
        );

    color:
        #a8bbb7;

    font-size:
        13px;

    text-align:center;
}

.account-status strong{

    color:
        #00ffae;
}

/* =========================================================
   FEATURES
========================================================= */

.features{

    display:grid;

    grid-template-columns:
        repeat(
            2,
            1fr
        );

    gap:10px;

    margin-top:
        25px;
}

.feature{

    padding:
        13px;

    border:
        1px solid
        rgba(
            0,
            255,
            174,
            .12
        );

    border-radius:
        12px;

    background:
        rgba(
            0,
            255,
            174,
            .025
        );

    color:
        #94aaa5;

    font-size:
        12px;
}

.feature span{

    display:block;

    color:
        #00ffae;

    font-weight:
        800;

    margin-bottom:
        4px;
}

/* =========================================================
   FOOTER
========================================================= */

.footer{

    text-align:center;

    padding:
        0
        20px
        35px;

    color:
        #46605a;

    font-size:
        11px;

    letter-spacing:
        2px;
}

@media(
    max-width:480px
){

    .container{
        margin-top:20px;
    }

    .card{
        padding:20px;
    }

    .features{
        grid-template-columns:
            1fr;
    }

    .code{
        font-size:24px;
        letter-spacing:5px;
    }

}

</style>

</head>

<body>

<div class="scanline"></div>

<header class="header">

    <div class="logo">
        ETIAS-MINI-BOT
    </div>

    <div class="subtitle">
        BRINGING AI TO YOUR FINGERTIPS
    </div>

</header>

<main class="container">

<div class="card">

    <div class="status">

        <div class="status-dot"></div>

        <span id="serverStatus">
            PAIRING SERVER ONLINE
        </span>

    </div>

    <div class="section-title">
        Connect WhatsApp
    </div>

    <div class="description">

        Enter the WhatsApp number you want
        to connect. A real WhatsApp pairing
        code will be generated.

    </div>

    <label class="label">
        WhatsApp Phone Number
    </label>

    <div class="input-wrap">

        <span class="prefix">+</span>

        <input
            id="phone"
            type="tel"
            inputmode="numeric"
            autocomplete="tel"
            placeholder="263778810589"
        >

    </div>

    <button
        id="generateBtn"
        class="generate"
        onclick="generateCode()"
    >
        ⚡ GENERATE PAIRING CODE
    </button>

    <div
        id="result"
        class="result"
    >

        <div class="result-title">
            WhatsApp Pairing Code
        </div>

        <div
            id="pairingCode"
            class="code"
        >
            --------
        </div>

        <button
            class="copy"
            onclick="copyCode()"
        >
            📋 COPY PAIRING CODE
        </button>

        <div
            id="accountStatus"
            class="account-status"
        >
            Waiting for WhatsApp...
        </div>

    </div>

    <div class="instructions">

        <div class="step">

            <div class="step-number">
                1
            </div>

            <div>
                Enter your WhatsApp number
                above using the country code.
                Do not use <b>+</b>.
            </div>

        </div>

        <div class="step">

            <div class="step-number">
                2
            </div>

            <div>
                Tap
                <b>GENERATE PAIRING CODE</b>.
            </div>

        </div>

        <div class="step">

            <div class="step-number">
                3
            </div>

            <div>
                Open WhatsApp →
                <b>Linked Devices</b>.
            </div>

        </div>

        <div class="step">

            <div class="step-number">
                4
            </div>

            <div>
                Tap
                <b>Link a device</b> →
                <b>Link with phone number instead</b>.
            </div>

        </div>

        <div class="step">

            <div class="step-number">
                5
            </div>

            <div>
                Enter the pairing code shown
                above.
            </div>

        </div>

    </div>

    <div class="features">

        <div class="feature">
            <span>⚡ PAIRING</span>
            Phone Number
        </div>

        <div class="feature">
            <span>🤖 COMMANDS</span>
            Commands Folder
        </div>

        <div class="feature">
            <span>🛡️ ANTIDELETE</span>
            Message Recovery
        </div>

        <div class="feature">
            <span>🔗 ANTILINK</span>
            Group Protection
        </div>

        <div class="feature">
            <span>👁️ ANTIVIEWONCE</span>
            Media Recovery
        </div>

        <div class="feature">
            <span>♻️ RECONNECT</span>
            Auto Restore
        </div>

    </div>

</div>

</main>

<footer class="footer">
    POWERED BY ETIAS-TECH • 2026
</footer>

<script>

let currentPhone = "";
let pollTimer = null;

/* =========================================================
   NORMALIZE PHONE
========================================================= */

function normalizePhone(value){

    return String(value || "")
        .replace(/\D/g, "")
        .replace(/^00/, "");

}

/* =========================================================
   GENERATE
========================================================= */

async function generateCode(){

    const input =
        document.getElementById(
            "phone"
        );

    const button =
        document.getElementById(
            "generateBtn"
        );

    const result =
        document.getElementById(
            "result"
        );

    const code =
        document.getElementById(
            "pairingCode"
        );

    const status =
        document.getElementById(
            "accountStatus"
        );

    const phone =
        normalizePhone(
            input.value
        );

    if(
        phone.length < 8 ||
        phone.length > 15
    ){

        alert(
            "Enter a valid WhatsApp number with country code."
        );

        return;
    }

    currentPhone =
        phone;

    button.disabled =
        true;

    button.innerText =
        "⏳ GENERATING...";

    result.classList.add(
        "show"
    );

    code.innerText =
        "WAITING";

    status.innerHTML =
        "🔄 Connecting to WhatsApp...";

    try{

        const response =
            await fetch(
                "/pair?number=" +
                encodeURIComponent(
                    phone
                )
            );

        const data =
            await response.json();

        if(
            !data.success
        ){

            throw new Error(
                data.error ||
                "Pairing failed"
            );

        }

        if(
            data.pairingCode
        ){

            showCode(
                data.pairingCode
            );

        }else{

            code.innerText =
                "WAITING";

        }

        updateStatus(
            data.status
        );

        startPolling();

    }catch(error){

        code.innerText =
            "ERROR";

        status.innerHTML =
            "❌ " +
            escapeHTML(
                error.message
            );

        console.error(
            error
        );

    }finally{

        button.disabled =
            false;

        button.innerText =
            "⚡ GENERATE PAIRING CODE";

    }

}

/* =========================================================
   SHOW CODE
========================================================= */

function showCode(
    value
){

    const code =
        document.getElementById(
            "pairingCode"
        );

    const result =
        document.getElementById(
            "result"
        );

    code.innerText =
        value;

    result.classList.add(
        "show"
    );

}

/* =========================================================
   COPY
========================================================= */

async function copyCode(){

    const code =
        document.getElementById(
            "pairingCode"
        ).innerText;

    if(
        !code ||
        code === "WAITING" ||
        code === "ERROR" ||
        code === "--------"
    ){
        return;
    }

    try{

        await navigator.clipboard.writeText(
            code
        );

        const button =
            document.querySelector(
                ".copy"
            );

        button.innerText =
            "✅ COPIED";

        setTimeout(
            () => {
                button.innerText =
                    "📋 COPY PAIRING CODE";
            },
            1800
        );

    }catch{

        alert(
            "Pairing code: " +
            code
        );

    }

}

/* =========================================================
   POLLING
========================================================= */

function startPolling(){

    if(
        pollTimer
    ){

        clearInterval(
            pollTimer
        );

    }

    pollTimer =
        setInterval(
            checkStatus,
            2500
        );

    checkStatus();

}

/* =========================================================
   STATUS
========================================================= */

async function checkStatus(){

    if(
        !currentPhone
    ){
        return;
    }

    try{

        const response =
            await fetch(
                "/status?number=" +
                encodeURIComponent(
                    currentPhone
                )
            );

        const data =
            await response.json();

        if(
            !data.success
        ){
            return;
        }

        if(
            data.pairingCode
        ){

            showCode(
                data.pairingCode
            );

        }

        updateStatus(
            data.status
        );

        const status =
            document.getElementById(
                "accountStatus"
            );

        if(
            data.status ===
            "open"
        ){

            status.innerHTML =
                "🟢 <strong>WHATSAPP CONNECTED</strong><br>" +
                "ETIAS-MINI-BOT is online.";

            if(
                pollTimer
            ){

                clearInterval(
                    pollTimer
                );

                pollTimer =
                    null;

            }

        }else if(
            data.status ===
            "connecting"
        ){

            status.innerHTML =
                "🟡 Connecting to WhatsApp...";

        }else if(
            data.status ===
            "closed"
        ){

            status.innerHTML =
                "🔄 Connection closed — reconnecting...";

        }else{

            status.innerHTML =
                "🔄 Waiting for WhatsApp...";

        }

    }catch(error){

        console.log(
            "Status error:",
            error
        );

    }

}

/* =========================================================
   SERVER STATUS
========================================================= */

function updateStatus(
    status
){

    const element =
        document.getElementById(
            "serverStatus"
        );

    if(
        status ===
        "open"
    ){

        element.innerText =
            "WHATSAPP CONNECTED";

    }else if(
        status ===
        "connecting"
    ){

        element.innerText =
            "WAITING FOR WHATSAPP";

    }else{

        element.innerText =
            "PAIRING SERVER ONLINE";

    }

}

/* =========================================================
   ESCAPE
========================================================= */

function escapeHTML(
    value
){

    return String(
        value
    )
    .replace(
        /&/g,
        "&amp;"
    )
    .replace(
        /</g,
        "&lt;"
    )
    .replace(
        />/g,
        "&gt;"
    )
    .replace(
        /"/g,
        "&quot;"
    )
    .replace(
        /'/g,
        "&#039;"
    );

}

/* =========================================================
   ENTER KEY
========================================================= */

document
    .getElementById(
        "phone"
    )
    .addEventListener(
        "keydown",
        event => {

            if(
                event.key ===
                "Enter"
            ){

                generateCode();

            }

        }
    );

</script>

</body>

</html>`);

    }
);

/* ============================================================
   PAIR API
============================================================ */

app.get(
    "/pair",
    async (req, res) => {

        try {

            const phone =
                normalizePhone(
                    req.query.number
                );

            if (
                !validatePhone(
                    phone
                )
            ) {

                return res
                    .status(400)
                    .json({
                        success:
                            false,

                        error:
                            "Enter a valid phone number with country code."
                    });

            }

            let session =
                sessions.get(
                    phone
                );

            /*
             * If there is no running socket,
             * create one.
             */
            if (
                !session?.sock ||
                session.status ===
                    "closed"
            ) {

                await createBot(
                    phone
                );

                session =
                    sessions.get(
                        phone
                    );

            }

            res.json({

                success:
                    true,

                phone,

                pairingCode:
                    session?.pairingCode ||
                    null,

                status:
                    session?.status ||
                    "connecting",

                message:
                    session?.pairingCode
                        ? "Enter the code in WhatsApp."
                        : "Waiting for pairing code."

            });

        } catch (error) {

            console.error(
                "[PAIR ERROR]",
                error
            );

            res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });

        }

    }
);

/* ============================================================
   CODE API
============================================================ */

app.get(
    "/code",
    async (req, res) => {

        try {

            const phone =
                normalizePhone(
                    req.query.number
                );

            if (
                !validatePhone(
                    phone
                )
            ) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

                        error:
                            "Invalid phone number."

                    });

            }

            let session =
                sessions.get(
                    phone
                );

            if (
                !session?.sock ||
                session.status ===
                    "closed"
            ) {

                await createBot(
                    phone
                );

                session =
                    sessions.get(
                        phone
                    );

            }

            res.json({

                success:
                    true,

                phone,

                code:
                    session?.pairingCode ||
                    null,

                status:
                    session?.status ||
                    "connecting"

            });

        } catch (error) {

            res
                .status(500)
                .json({

                    success:
                        false,

                    error:
                        error.message

                });

        }

    }
);

/* ============================================================
   STATUS API
============================================================ */

app.get(
    "/status",
    (req, res) => {

        const phone =
            normalizePhone(
                req.query.number
            );

        const session =
            sessions.get(
                phone
            );

        if (!session) {

            return res.json({

                success:
                    true,

                phone,

                status:
                    "offline",

                pairingCode:
                    null

            });

        }

        res.json({

            success:
                true,

            phone,

            status:
                session.status,

            pairingCode:
                session.pairingCode ||
                null

        });

    }
);

/* ============================================================
   SESSIONS API
============================================================ */

app.get(
    "/sessions",
    (req, res) => {

        const result =
            [];

        for (
            const [
                phone,
                session
            ]
            of sessions
        ) {

            result.push({

                phone,

                status:
                    session.status,

                pairingCode:
                    session.pairingCode ||
                    null

            });

        }

        res.json({

            success:
                true,

            count:
                result.length,

            sessions:
                result

        });

    }
);

/* ============================================================
   HEALTH API
============================================================ */

app.get(
    "/health",
    (req, res) => {

        res.json({

            success:
                true,

            bot:
                "ETIAS-MINI-BOT",

            status:
                "online",

            pairing:
                "phone-number",

            sessionId:
                false,

            commands:
                true,

            antidelete:
                true,

            antilink:
                true,

            antiviewonce:
                true,

            viewonce:
                true,

            accounts:
                sessions.size,

            uptime:
                process.uptime()

        });

    }
);

/* ============================================================
   START SERVER
============================================================ */

function startServer() {

    if (
        global.__ETIAS_SERVER_STARTED
    ) {
        return;
    }

    global.__ETIAS_SERVER_STARTED =
        true;

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log("");

            console.log(
                "╔══════════════════════════════════════════════════╗"
            );

            console.log(
                "║              ETIAS-MINI-BOT                    ║"
            );

            console.log(
                "║           FUTURISTIC PAIR SERVER               ║"
            );

            console.log(
                "╠══════════════════════════════════════════════════╣"
            );

            console.log(
                `║ Port: ${PORT}`
            );

            console.log(
                "║ Pairing: PHONE NUMBER"
            );

            console.log(
                "║ Session ID: DISABLED"
            );

            console.log(
                "║ Commands: ENABLED"
            );

            console.log(
                "║ Multi Account: ENABLED"
            );

            console.log(
                "║ AntiDelete: ENABLED"
            );

            console.log(
                "║ AntiLink: ENABLED"
            );

            console.log(
                "║ AntiViewOnce: ENABLED"
            );

            console.log(
                "║ ViewOnce: ENABLED"
            );

            console.log(
                "║ Auto Reconnect: ENABLED"
            );

            console.log(
                "╚══════════════════════════════════════════════════╝"
            );

            console.log("");

            console.log(
                `[SERVER] http://localhost:${PORT}`
            );

            console.log(
                `[SERVER] Pairing UI: http://localhost:${PORT}/`
            );

        }
    );
}

/* ============================================================
   DIRECT START
============================================================ */

if (
    require.main ===
    module
) {

    startServer();

}

/* ============================================================
   EXPORTS
============================================================ */

module.exports = {

    app,

    startServer,

    createBot,

    sessions,

    normalizePhone,

    validatePhone,

    getAuthPath,

    getMessageStore

};
