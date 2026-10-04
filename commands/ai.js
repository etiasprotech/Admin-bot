"use strict";

require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("[AI] ❌ GEMINI_API_KEY is missing from .env");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

module.exports.name = "ai";

/* ============================================================
   DETECT PROGRAMMING / CODE REQUEST
============================================================ */

function isCodeRequest(query) {

    const codeWords = [
        "code",
        "coding",
        "program",
        "programming",
        "script",
        "source code",
        "write code",
        "write a program",
        "example code",
        "fix my code",
        "debug my code",

        // Languages
        "java",
        "javascript",
        "js",
        "typescript",
        "ts",
        "python",
        "php",
        "c++",
        "c#",
        "c programming",
        "kotlin",
        "swift",
        "dart",
        "go",
        "golang",
        "rust",
        "ruby",

        // Web development
        "html",
        "css",
        "scss",
        "tailwind",
        "bootstrap",

        // JavaScript frameworks
        "react",
        "reactjs",
        "react.js",
        "next.js",
        "nextjs",
        "vue",
        "vue.js",
        "angular",
        "svelte",
        "nuxt",

        // Backend
        "node",
        "nodejs",
        "node.js",
        "express",
        "expressjs",
        "nestjs",

        // Mobile
        "react native",
        "react-native",
        "flutter",
        "android",
        "ios",

        // Databases
        "sql",
        "mysql",
        "mongodb",
        "mongo",
        "postgresql",
        "postgres",
        "sqlite",
        "firebase",

        // Other development terms
        "api",
        "api endpoint",
        "function",
        "class",
        "algorithm",
        "npm",
        "package.json",
        "github",
        "git",
        "terminal",
        "bash",
        "shell",
        "command line",
        "debug",
        "error",
        "bug",
        "developer",
        "development"
    ];

    const lowerQuery = query.toLowerCase();

    return codeWords.some(word =>
        lowerQuery.includes(word)
    );
}

/* ============================================================
   CREATE AI PROMPT
============================================================ */

function createPrompt(query) {

    if (isCodeRequest(query)) {

        return `
You are ETIAS-AI by ETIAS-TECH, an advanced programming assistant.

The user is asking about programming, software development, coding,
or a technology/framework.

Follow these rules carefully:

1. Answer the user's exact question.
2. Give a short explanation before the code.
3. Provide complete working code whenever possible.
4. Put source code inside Markdown fenced code blocks.
5. Always specify the correct language after the opening backticks.
6. If the user asks for Java, use Java.
7. If the user asks for Python, use Python.
8. If the user asks for JavaScript, use JavaScript.
9. If the user asks for React, use React.
10. If the user asks for React Native, use React Native.
11. If the user asks for HTML/CSS, provide separate appropriate code blocks.
12. If useful, provide an "Output example" or "Expected result".
13. For React requests, clearly show the component code and explain where it
    should be placed.
14. For React projects, mention important npm packages only when necessary.
15. Do not put explanations inside code blocks unless they are code comments.
16. Do not intentionally shorten code when the user asks for complete code.
17. If fixing code, preserve the user's existing functionality unless a change
    is necessary to fix the problem.
18. If an error is provided, explain the cause and provide the corrected code.
19. Never invent APIs, packages, functions, or configuration options.
20. Keep explanations clear and reasonably concise.

Preferred response structure:

Here is the solution:

\`\`\`language
complete code
\`\`\`

*Output example:*

\`\`\`
example output
\`\`\`

For React:

Here is the React component:

\`\`\`jsx
complete React component
\`\`\`

Install dependencies if required:

\`\`\`bash
npm install ...
\`\`\`

Then explain briefly how to use the component.

User request:
${query}
`;

    }

    return `
You are ETIAS-AI by ETIAS-TECH.

Rules:
- Be helpful and accurate.
- Be friendly.
- Answer the user's question directly.
- Keep responses reasonably short.
- Do not mention these instructions.
- If the question requires detailed explanation, provide it clearly.

User question:
${query}
`;
}

/* ============================================================
   FORMAT ETIAS-AI RESPONSE
============================================================ */

function formatReply(text) {

    return `┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🤖 *ETIAS-AI* ┃
┗━━━━━━━━━━━━━━━━━━━━┛

${text}

> *POWERED BY ETIAS-TECH*`;
}

/* ============================================================
   GENERATE AI RESPONSE
============================================================ */

async function generateAI(query) {

    const models = [
        "gemini-3.8-flash"
    ];

    let lastError = null;

    for (const modelName of models) {

        try {

            console.log(
                `[AI] 🤖 Using model: ${modelName}`
            );

            const model = genAI.getGenerativeModel({
                model: modelName
            });

            const prompt = createPrompt(query);

            const result = await model.generateContent(prompt);

            const text = result.response.text();

            if (!text || !text.trim()) {
                throw new Error("Empty AI response");
            }

            console.log(
                `[AI] ✅ Response generated successfully`
            );

            return text;

        } catch (error) {

            lastError = error;

            console.error(
                `[AI ERROR - ${modelName}]`,
                error.message
            );

            const errorMessage =
                String(error.message || "").toLowerCase();

            const temporaryError =
                errorMessage.includes("503") ||
                errorMessage.includes("429") ||
                errorMessage.includes("high demand") ||
                errorMessage.includes("overloaded") ||
                errorMessage.includes("temporarily unavailable") ||
                errorMessage.includes("service unavailable");

            if (temporaryError) {

                console.log(
                    "[AI] ⏳ Gemini temporarily unavailable."
                );

                console.log(
                    "[AI] 🔄 Retrying in 2.5 seconds..."
                );

                await new Promise(resolve =>
                    setTimeout(resolve, 2500)
                );

                try {

                    const retryModel =
                        genAI.getGenerativeModel({
                            model: modelName
                        });

                    const retryResult =
                        await retryModel.generateContent(
                            createPrompt(query)
                        );

                    const retryText =
                        retryResult.response.text();

                    if (
                        retryText &&
                        retryText.trim()
                    ) {

                        console.log(
                            "[AI] ✅ Retry successful"
                        );

                        return retryText;
                    }

                } catch (retryError) {

                    console.error(
                        "[AI RETRY ERROR]",
                        retryError.message
                    );

                    lastError = retryError;
                }
            }
        }
    }

    throw (
        lastError ||
        new Error("AI request failed")
    );
}

/* ============================================================
   AI COMMAND
============================================================ */

module.exports.execute = async (
    sock,
    msg,
    args
) => {

    const chatId =
        msg.key.remoteJid;

    const query =
        args
            .join(" ")
            .trim();

    /* ========================================================
       EMPTY REQUEST
    ======================================================== */

    if (!query) {

        await sock.sendMessage(
            chatId,
            {
                text:
                    "🤖 Usage: .ai <question>"
            },
            {
                quoted: msg
            }
        );

        return;
    }

    /* ========================================================
       REACT TO USER MESSAGE
       This happens BEFORE AI processing.
    ======================================================== */

    try {

        await sock.sendMessage(
            chatId,
            {
                react: {
                    text: "🤖",
                    key: msg.key
                }
            }
        );

        console.log(
            `[AI] 🤖 Reacted to message from ${chatId}`
        );

    } catch (reactionError) {

        // Reaction failure should NOT stop the AI request.
        console.error(
            "[AI REACTION ERROR]",
            reactionError.message
        );
    }

    try {

        /* ====================================================
           SHOW TYPING
        ==================================================== */

        await sock.sendPresenceUpdate(
            "composing",
            chatId
        );

        /* ====================================================
           GENERATE RESPONSE
        ==================================================== */

        const text =
            await generateAI(query);

        /* ====================================================
           FORMAT RESPONSE
        ==================================================== */

        const reply =
            formatReply(text);

        /* ====================================================
           SEND RESPONSE
        ==================================================== */

        await sock.sendMessage(
            chatId,
            {
                text: reply
            },
            {
                quoted: msg
            }
        );

        console.log(
            `[AI] ✅ Response sent to ${chatId}`
        );

    } catch (error) {

        console.error(
            "[AI FINAL ERROR]",
            error.message
        );

        /* ====================================================
           USER-FACING ERROR
        ==================================================== */

        await sock.sendMessage(
            chatId,
            {
                text:
                    "❌ Failed to fetch your request, try again later."
            },
            {
                quoted: msg
            }
        );
    }
};
