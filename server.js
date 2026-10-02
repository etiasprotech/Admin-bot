"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_DIR = path.join(__dirname, "auth");

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });
}

app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));

const sessions = new Map();

/* ============================================================
   PAIRING WEB PAGE
============================================================ */

app.get("/", (req, res) => {

    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>ETIAS MINI BOT</title>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;

    min-height: 100vh;

    display: flex;

    align-items: center;

    justify-content: center;

    font-family: Arial, sans-serif;

    background:
        radial-gradient(
            circle at top,
            #123c4a,
            #05080b 55%
        );

    color: white;
}

.container {

    width: 92%;

    max-width: 450px;

    padding: 30px;

    border-radius: 25px;

    background: rgba(10, 20, 25, .88);

    border: 1px solid rgba(0,255,255,.25);

    box-shadow:
        0 0 40px rgba(0,255,255,.15);
}

.logo {

    text-align: center;

    font-size: 32px;

    font-weight: bold;

    color: #00ffff;

    text-shadow:
        0 0 15px #00ffff;
}

.subtitle {

    text-align: center;

    color: #aaa;

    margin: 10px 0 30px;
}

label {

    display: block;

    margin-bottom: 8px;

    color: #00ffff;
}

input {

    width: 100%;

    padding: 15px;

    border-radius: 12px;

    border: 1px solid #00ffff44;

    background: #071116;

    color: white;

    outline: none;

    font-size: 16px;
}

button {

    width: 100%;

    margin-top: 18px;

    padding: 15px;

    border: 0;

    border-radius: 12px;

    background:
        linear-gradient(
            90deg,
            #00ffff,
            #008cff
        );

    color: #001014;

    font-size: 16px;

    font-weight: bold;

    cursor: pointer;
}

button:disabled {

    opacity: .5;

    cursor: not-allowed;
}

#result {

    display: none;

    margin-top: 25px;

    padding: 20px;

    border-radius: 15px;

    background: #061a20;

    border: 1px solid #00ffff44;
}

.code {

    text-align: center;

    font-size: 28px;

    font-weight: bold;

    letter-spacing: 5px;

    color: #00ffff;

    margin: 15px 0;
}

.instructions {

    color: #aaa;

    line-height: 1.6;

    font-size: 14px;
}

.error {

    color: #ff5555;
}

.success {

    color: #00ff9d;
}

</style>

</head>

<body>

<div class="container">

    <div class="logo">
        ETIAS-MINI-BOT
    </div>

    <div class="subtitle">
        WhatsApp Pairing Panel
    </div>

    <form id="pairForm">

        <label>
            WhatsApp Number
        </label>

        <input
            id="phone"
            type="tel"
            placeholder="263771234567"
            autocomplete="tel"
            required
        >

        <button id="pairBtn">
            GET PAIRING CODE
        </button>

    </form>

    <div id="result"></div>

</div>

<script>

const form =
    document.getElementById("pairForm");

const phoneInput =
    document.getElementById("phone");

const button =
    document.getElementById("pairBtn");

const result =
    document.getElementById("result");


/* ============================================================
   PAIR FORM
============================================================ */

form.addEventListener("submit", async (e) => {

    e.preventDefault();

    let phone = phoneInput.value
        .replace(/[^0-9]/g, "");

    if (!phone) {

        showError(
            "Enter a valid WhatsApp number."
        );

        return;
    }

    if (phone.length < 8) {

        showError(
            "Enter the number in international format."
        );

        return;
    }

    button.disabled = true;

    button.textContent =
        "GENERATING...";

    result.style.display =
        "block";

    result.innerHTML =
        "Connecting to WhatsApp...";

    try {

        const response =
            await fetch("/pair", {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    phone: phone
                })

            });


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.error ||
                "Pairing failed"
            );
        }


        if (!data.code) {

            throw new Error(
                "WhatsApp did not return a pairing code."
            );
        }


        result.innerHTML =
            '<div class="success">PAIRING CODE</div>' +

            '<div class="code">' +
                escapeHtml(data.code) +
            '</div>' +

            '<div class="instructions">' +

                '1. Open WhatsApp on the phone.<br>' +

                '2. Go to <b>Settings → Linked Devices</b>.<br>' +

                '3. Select <b>Link a Device</b>.<br>' +

                '4. Choose <b>Link with phone number instead</b>.<br>' +

                '5. Enter the pairing code shown above.' +

            '</div>';

    } catch (error) {

        showError(
            error.message
        );

    } finally {

        button.disabled = false;

        button.textContent =
            "GET PAIRING CODE";
    }

});


/* ============================================================
   ERROR
============================================================ */

function showError(message) {

    result.style.display =
        "block";

    result.innerHTML =
        '<div class="error">' +
        escapeHtml(message) +
        '</div>';
}


/* ============================================================
   HTML ESCAPE
============================================================ */

function escapeHtml(value) {

    return String(value)

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;")

        .replace(/"/g, "&quot;")

        .replace(/'/g, "&#039;");
}

</script>

</body>

</html>
    `);

});


/* ============================================================
   PAIR NUMBER
============================================================ */

app.post("/pair", async (req, res) => {

    try {

        let phone = String(
            req.body.phone || ""
        ).replace(/[^0-9]/g, "");


        if (!phone) {

            return res.status(400).json({
                error:
                    "Phone number is required."
            });

        }


        if (phone.length < 8) {

            return res.status(400).json({
                error:
                    "Invalid phone number."
            });

        }


        console.log(
            `[PAIR] Request received for ${phone}`
        );


        const result =
            await createBot(phone);


        return res.json({

            success: true,

            phone: phone,

            code: result.code

        });

    } catch (error) {

        console.error(
            "[PAIR ERROR]",
            error
        );


        return res.status(500).json({

            error:
                error.message ||
                "Pairing failed."

        });

    }

});


/* ============================================================
   CREATE WHATSAPP BOT
============================================================ */

async function createBot(phone) {

    /*
     * If the account is already connected,
     * don't create another socket.
     */

    if (sessions.has(phone)) {

        const existing =
            sessions.get(phone);


        if (existing.sock) {

            /*
             * If it is already registered,
             * don't request another code.
             */

            if (
                existing.state &&
                existing.state.creds &&
                existing.state.creds.registered
            ) {

                return {
                    sock: existing.sock,
                    code: "ALREADY_PAIRED"
                };

            }


            try {

                const code =
                    await existing.sock
                        .requestPairingCode(phone);


                return {
                    sock: existing.sock,
                    code: code
                };

            } catch (error) {

                console.log(
                    `[${phone}] Existing socket pairing failed:`,
                    error.message
                );

            }

        }

    }


    /*
     * Each phone number gets its own auth directory.
     */

    const authPath =
        path.join(
            AUTH_DIR,
            phone
        );


    if (!fs.existsSync(authPath)) {

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
    } = await useMultiFileAuthState(
        authPath
    );


    /* ========================================================
       BAILEYS VERSION
    ======================================================== */

    let version;

    try {

        const latest =
            await fetchLatestBaileysVersion();

        version =
            latest.version;

        console.log(
            `[${phone}] Baileys version:`,
            version.join(".")
        );

    } catch (error) {

        console.log(
            "[WHATSAPP] Could not fetch latest Baileys version:",
            error.message
        );

        /*
         * Fallback version.
         */

        version =
            [2, 3000, 1015901307];

    }


    /* ========================================================
       SOCKET
    ======================================================== */

    const sock =
        makeWASocket({

            version: version,

            auth: state,

            printQRInTerminal: false,

            logger: pino({
                level: "silent"
            }),

            browser: [
                "ETIAS-MINI-BOT",
                "Chrome",
                "1.0.0"
            ],

            generateHighQualityLinkPreview:
                true,

            syncFullHistory:
                false

        });


    /*
     * Store everything required by this account.
     */

    sessions.set(
        phone,
        {
            sock: sock,
            saveCreds: saveCreds,
            state: state
        }
    );


    /* ========================================================
       SAVE CREDENTIALS
    ======================================================== */

    sock.ev.on(
        "creds.update",
        saveCreds
    );


    /* ========================================================
       CONNECTION UPDATE
    ======================================================== */

    sock.ev.on(
        "connection.update",
        async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;


            if (
                connection === "connecting"
            ) {

                console.log(
                    `[${phone}] Connecting...`
                );

            }


            if (
                connection === "open"
            ) {

                console.log(
                    `\n[${phone}] ✅ WHATSAPP CONNECTED\n`
                );

            }


            if (
                connection === "close"
            ) {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;


                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;


                console.log(
                    `[${phone}] Connection closed. Reconnect: ${shouldReconnect}`
                );


                sessions.delete(
                    phone
                );


                if (
                    shouldReconnect
                ) {

                    setTimeout(
                        () => {

                            createBot(
                                phone
                            ).catch(error => {

                                console.error(
                                    `[${phone}] Reconnect error:`,
                                    error.message
                                );

                            });

                        },
                        5000
                    );

                } else {

                    console.log(
                        `[${phone}] Logged out from WhatsApp.`
                    );

                }

            }

        }
    );


    /* ========================================================
       REQUEST PAIRING CODE
    ======================================================== */

    if (
        !state.creds.registered
    ) {

        /*
         * Wait for socket initialization.
         */

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    2000
                )
        );


        const code =
            await sock.requestPairingCode(
                phone
            );


        console.log(
            `[${phone}] PAIRING CODE: ${code}`
        );


        return {

            sock: sock,

            code: code

        };

    }


    /*
     * Already authenticated.
     */

    return {

        sock: sock,

        code:
            "ALREADY_PAIRED"

    };

}


/* ============================================================
   STATUS
============================================================ */

app.get("/status", (req, res) => {

    const result = [];


    for (
        const [phone, data]
        of sessions
    ) {

        result.push({

            phone: phone,

            connected:
                !!data.sock

        });

    }


    res.json({

        success: true,

        total:
            result.length,

        bots:
            result

    });

});


/* ============================================================
   HEALTH
============================================================ */

app.get("/health", (req, res) => {

    res.json({

        status:
            "online",

        bot:
            "ETIAS-MINI-BOT",

        pairing:
            "phone-number",

        sessionId:
            false

    });

});


/* ============================================================
   SERVER
============================================================ */

app.listen(
    PORT,
    () => {

        console.log(`
╔══════════════════════════════════════╗
║        ETIAS-MINI-BOT SERVER        ║
╠══════════════════════════════════════╣
║ Port: ${PORT}
║ Pairing: PHONE NUMBER
║ Session ID: DISABLED
╚══════════════════════════════════════╝
`);

    }
);


/* ============================================================
   EXPORTS
============================================================ */

module.exports = {

    createBot,

    sessions

};
