"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
    createBot,
    startServer
} = require("./server");

/* ============================================================
   PATHS
============================================================ */

const AUTH_DIR = path.join(__dirname, "auth");
const COMMANDS_DIR = path.join(__dirname, "commands");
const DATABASE_DIR = path.join(__dirname, "database");

/* ============================================================
   DIRECTORIES
============================================================ */

for (const dir of [
    AUTH_DIR,
    COMMANDS_DIR,
    DATABASE_DIR
]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }
}

/* ============================================================
   COMMAND SYSTEM
============================================================ */

const commands = new Map();

function loadCommands() {

    commands.clear();

    if (!fs.existsSync(COMMANDS_DIR)) {
        console.log(
            "[COMMANDS] commands folder not found"
        );

        return;
    }

    const files = fs
        .readdirSync(COMMANDS_DIR)
        .filter(file => file.endsWith(".js"));

    for (const file of files) {

        const filePath =
            path.join(
                COMMANDS_DIR,
                file
            );

        try {

            delete require.cache[
                require.resolve(filePath)
            ];

            const command =
                require(filePath);

            if (!command) {
                continue;
            }

            const name =
                command.name ||
                command.command ||
                command.cmd;

            /*
             * Some modules may be event-only.
             */
            if (!name) {

                if (
                    typeof command.init === "function" ||
                    typeof command.register === "function" ||
                    typeof command.onMessage === "function"
                ) {
                    console.log(
                        `[COMMAND] Loaded event module: ${file}`
                    );
                } else {
                    console.log(
                        `[COMMANDS] Skipped ${file} - no command name`
                    );
                }

                continue;
            }

            const commandName =
                String(name).toLowerCase();

            commands.set(
                commandName,
                command
            );

            console.log(
                `[COMMAND] Loaded: ${commandName}`
            );

            const aliases =
                Array.isArray(command.aliases)
                    ? command.aliases
                    : [];

            for (const alias of aliases) {

                const aliasName =
                    String(alias).toLowerCase();

                commands.set(
                    aliasName,
                    command
                );
            }

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

/* ============================================================
   LOAD COMMANDS
============================================================ */

loadCommands();

/* ============================================================
   GLOBAL COMMANDS
============================================================ */

global.commands = commands;

global.etiasCommands = commands;

global.botConfig = {

    prefix: ".",

    features: {
        antidelete: true,
        antilink: true,
        antiviewonce: true,
        viewonce: true
    }
};

/* ============================================================
   START EXPRESS SERVER
============================================================ */

try {

    startServer();

} catch (error) {

    console.error(
        "[SERVER] Failed to start:",
        error
    );
}

/* ============================================================
   RESTORE SAVED WHATSAPP ACCOUNTS
============================================================ */

async function restoreBots() {

    if (!fs.existsSync(AUTH_DIR)) {

        console.log(
            "[RESTORE] No auth directory"
        );

        return;
    }

    const entries =
        fs.readdirSync(
            AUTH_DIR,
            {
                withFileTypes: true
            }
        );

    const accounts =
        entries
            .filter(
                entry =>
                    entry.isDirectory()
            )
            .map(
                entry =>
                    entry.name
            )
            .filter(
                phone =>
                    /^[0-9]+$/.test(phone)
            );

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

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1500
                )
        );
    }
}

/* ============================================================
   START BOT SYSTEM
============================================================ */

async function start() {
    console.log(`
╔════════════════════════════════════════════╗
║            ETIAS-MINI-BOT                 ║
║            MULTI ACCOUNT BOT              ║
╠════════════════════════════════════════════╣
║ Pairing: WhatsApp Phone Number            ║
║ Session ID: DISABLED                      ║
║ Commands: ENABLED                         ║
║ Auto Restore: ENABLED                     ║
║ AntiDelete: ENABLED                       ║
║ AntiLink: ENABLED                         ║
║ AntiViewOnce: ENABLED                     ║
║ ViewOnce: ENABLED                          ║
║ Multi Account: ENABLED                    ║
║ Auto Reconnect: ENABLED                   ║
╚════════════════════════════════════════════╝
    `);

    /* START HTTP SERVER */
    startServer();

    /* RESTORE SAVED ACCOUNTS */
    await restoreBots();

    console.log(
        "[SYSTEM] ETIAS-MINI-BOT is ready"
    );
}

/* ============================================================
   START
============================================================ */

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

process.on(
    "SIGINT",
    () => {

        console.log(
            "\n[SYSTEM] Shutting down..."
        );

        process.exit(0);

    }
);

process.on(
    "SIGTERM",
    () => {

        console.log(
            "\n[SYSTEM] SIGTERM received..."
        );

        process.exit(0);

    }
);
