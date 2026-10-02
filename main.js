"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
    createBot
} = require("./server");

/* ============================================================
   CONFIG
============================================================ */

const AUTH_DIR = path.join(__dirname, "auth");
const COMMANDS_DIR = path.join(__dirname, "commands");

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });
}

/* ============================================================
   COMMAND SYSTEM
============================================================ */

const commands = new Map();

function loadCommands() {

    if (!fs.existsSync(COMMANDS_DIR)) {
        console.log("[COMMANDS] commands folder not found");
        return;
    }

    const files = fs
        .readdirSync(COMMANDS_DIR)
        .filter(file => file.endsWith(".js"));

    for (const file of files) {

        const filePath = path.join(
            COMMANDS_DIR,
            file
        );

        try {

            delete require.cache[
                require.resolve(filePath)
            ];

            const command = require(filePath);

            if (!command) {
                continue;
            }

            const name =
                command.name ||
                command.command ||
                command.cmd;

            if (!name) {

                console.log(
                    `[COMMANDS] Skipped ${file} - no command name`
                );

                continue;
            }

            const aliases = Array.isArray(command.aliases)
                ? command.aliases
                : [];

            commands.set(
                String(name).toLowerCase(),
                command
            );

            for (const alias of aliases) {

                commands.set(
                    String(alias).toLowerCase(),
                    command
                );
            }

            console.log(
                `[COMMAND] Loaded: ${name}`
            );

        } catch (error) {

            console.error(
                `[COMMAND] Failed to load ${file}`
            );

            console.error(error);
        }
    }

    console.log(
        `[COMMANDS] ${commands.size} commands available`
    );
}

loadCommands();

/* ============================================================
   EXPORT COMMANDS GLOBALLY
============================================================ */

global.commands = commands;

/* ============================================================
   START PAIRING WEB SERVER
============================================================ */

require("./server");

/* ============================================================
   RESTORE SAVED BOTS
============================================================ */

async function restoreBots() {

    if (!fs.existsSync(AUTH_DIR)) {

        console.log(
            "[RESTORE] auth folder does not exist"
        );

        return;
    }

    const entries = fs.readdirSync(
        AUTH_DIR,
        {
            withFileTypes: true
        }
    );

    const accounts = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(phone => /^[0-9]+$/.test(phone));

    if (accounts.length === 0) {

        console.log(
            "[RESTORE] No saved WhatsApp accounts"
        );

        return;
    }

    console.log(
        `[RESTORE] ${accounts.length} saved account(s) found`
    );

    for (const phone of accounts) {

        try {

            console.log(
                `[RESTORE] Connecting ${phone}...`
            );

            await createBot(phone);

            console.log(
                `[RESTORE] ${phone} initialized`
            );

        } catch (error) {

            console.error(
                `[RESTORE] Failed ${phone}:`,
                error.message
            );
        }

        /*
         * Small delay between accounts.
         * Helps avoid creating many connections
         * at exactly the same time.
         */

        await new Promise(resolve =>
            setTimeout(resolve, 1000)
        );
    }
}

/* ============================================================
   START BOT SYSTEM
============================================================ */

async function start() {

    console.log(`
╔══════════════════════════════════════════╗
║          ETIAS-MINI-BOT                 ║
║          MULTI ACCOUNT BOT              ║
╠══════════════════════════════════════════╣
║ Pairing: WhatsApp Phone Number          ║
║ Session ID: DISABLED                    ║
║ Commands: ENABLED                       ║
║ Auto Restore: ENABLED                   ║
╚══════════════════════════════════════════╝
`);

    await restoreBots();

    console.log(
        "[SYSTEM] ETIAS-MINI-BOT is ready"
    );
}

start().catch(error => {

    console.error(
        "[SYSTEM] Startup error:",
        error
    );

});

/* ============================================================
   ERROR HANDLING
============================================================ */

process.on(
    "uncaughtException",
    error => {

        console.error(
            "[UNCAUGHT EXCEPTION]",
            error
        );

    }
);

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[UNHANDLED REJECTION]",
            error
        );

    }
);

/* ============================================================
   GRACEFUL SHUTDOWN
============================================================ */

async function shutdown(signal) {

    console.log(
        `[SYSTEM] ${signal} received`
    );

    console.log(
        "[SYSTEM] Shutting down..."
    );

    /*
     * Baileys sockets are managed by server.js.
     * We don't delete auth files here.
     */

    process.exit(0);
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

/* ============================================================
   EXPORTS
============================================================ */

module.exports = {
    commands,
    loadCommands,
    restoreBots
};


