// ======================================
// IMPORTS
// ======================================

require('dotenv').config();

const pino = require('pino');

const {
    useMultiFileAuthState,
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// ======================================
// HELPERS DE CONFIG
// ======================================

const toBool = (value) =>
    String(value || '').toLowerCase() === 'true';

const splitCsv = (value) =>
    String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

// ======================================
// CONFIG (variables de entorno)
// ======================================

// DEBUG (true/false). Detalle completo solo si es true;
// los marcadores de una línea siempre se muestran.
const DEBUG_MODE = toBool(process.env.DEBUG_MODE ?? 'false');

// ======================================
// GRUPOS AUTORIZADOS
// ======================================

// CSV. Si vacío = TODOS los grupos
const ALLOWED_GROUPS = splitCsv(process.env.ALLOWED_GROUPS);

// ======================================
// USUARIOS AUTORIZADOS
// ======================================

// CSV. Acepta número de teléfono, '@c.us' o '@lid'.
// Vacío = TODOS los usuarios
const ALLOWED_USERS = splitCsv(
    process.env.ALLOWED_USERS || '2839174721783@lid'
);

// ======================================
// PALABRAS CLAVE
// ======================================

// CSV
const KEYWORDS = splitCsv(
    process.env.KEYWORDS ||
        'aeropuerto,terminal 1,terminal 2,terminal 3'
);

// ======================================
// RESPUESTAS (variadas)
// ======================================

// CSV (AUTO_REPLIES). Si existe AUTO_REPLY (legacy) se usa como única.
const AUTO_REPLIES = process.env.AUTO_REPLIES
    ? splitCsv(process.env.AUTO_REPLIES)
    : process.env.AUTO_REPLY
        ? splitCsv(process.env.AUTO_REPLY)
        : [
            'Yo, estoy al tanto.',
            'Sí, ya lo sé, estoy al tanto.',
            'Enterado, sin problema.',
            'Tranquilo, ya me encargo.',
            'Ya lo tengo visto, no hay bronca.'
        ];

// ======================================
// SESIÓN (Baileys multi-file)
// ======================================

const SESSION_PATH =
    process.env.SESSION_PATH || '.baileys_auth';

// ======================================
// NORMALIZACIÓN DE USUARIOS
// ======================================

// Extrae solo dígitos (quita '+', espacios, '-', etc.)
const toDigits = (value) =>
    String(value || '')
        .replace(/\D+/g, '');

// IDs completos (contienen '@'): @c.us / @s.whatsapp.net / @lid
const allowedIds = new Set(
    ALLOWED_USERS
        .filter((u) => u.includes('@'))
        .map((u) => u.toLowerCase().trim())
);

// Números de teléfono (dígitos), de TODAS las entradas
const allowedNumbers = new Set(
    ALLOWED_USERS
        .map(toDigits)
        .filter(Boolean)
);

// Resuelve si un remitente está autorizado,
// normalizando LID / @s.whatsapp.net a número de teléfono.
const isUserAllowed = (author) => {

    const id = String(author || '')
        .toLowerCase()
        .trim();

    // 1) Match directo con ID completo
    if (allowedIds.has(id)) {
        return true;
    }

    // 2) Match por dígitos (funciona con @s.whatsapp.net y @lid)
    const digits = toDigits(id);

    return digits.length > 0 && allowedNumbers.has(digits);
};

// ======================================
// RESPUESTAS: selección variada
// ======================================

let lastReply = null;

const pickReply = () => {

    const pool =
        AUTO_REPLIES.length > 1
            ? AUTO_REPLIES.filter((r) => r !== lastReply)
            : AUTO_REPLIES;

    const chosen =
        pool[Math.floor(Math.random() * pool.length)];

    lastReply = chosen;
    return chosen;
};

// ======================================
// DELAY HUMANO (jitter 1.2s - 2.5s)
// ======================================

const delay = (min, max) => {

    const ms =
        min + Math.random() * (max - min);

    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
};

// ======================================
// QR (capturado para el servidor web)
// ======================================

let latestQr = null;

const getQr = () => latestQr;

// ======================================
// CLIENTE (Baileys)
// ======================================

let reconnecting = false;

const start = async () => {

    const { state, saveCreds } =
        await useMultiFileAuthState(SESSION_PATH);

    const { version } =
        await fetchLatestBaileysVersion();

    const sock = makeWASocket({

        version,

        auth: state,

        // Silencia el logger ruidoso de Baileys (pino)
        logger: pino({ level: 'silent' }),

        browser: ['WSbot', 'Chrome', '151'],

        markOnlineOnConnect: false,

        syncFullHistory: false,

        // Evita prefetch de contactos/sesiones innecesarios
        downloadHistory: false,

        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    // ===============================
    // CONNECTION
    // ===============================

    sock.ev.on('connection.update', (update) => {

        const { connection, lastDisconnect, qr } = update;

        if (qr) {

            latestQr = qr;

            console.log(
                '\n📱 QR generado. Escanea en /qr (con QR_TOKEN)\n'
            );

            return;
        }

        if (connection === 'open') {

            latestQr = null;

            console.log(
                '\n✅ BOT CONECTADO\n'
            );

            return;
        }

        if (connection === 'close') {

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut;

            if (!shouldReconnect) {

                console.log(
                    '\n🚨 Sesión cerrada (loggedOut). Re-escanea el QR en /qr\n'
                );

                process.exit(0);
            }

            if (reconnecting) return;

            reconnecting = true;

            const attempt = (lastDisconnect?.error?.output?.statusCode
                ? lastDisconnect.error.output.statusCode
                : 0) || 1;

            const wait =
                Math.min(1000 * 2 ** attempt, 60000);

            console.log(
                `\n🔄 Reconectando en ${Math.round(wait / 1000)}s...\n`
            );

            setTimeout(() => {
                reconnecting = false;
                start().catch(() => process.exit(1));
            }, wait);
        }
    });

    // ===============================
    // MENSAJES
    // ===============================

    sock.ev.on('messages.upsert', async ({ type, messages }) => {

        // Solo mensajes nuevos (no history-sync)
        if (type !== 'notify') return;

        try {

            const msg = messages[0];

            if (!msg) return;

            // ===============================
            // IGNORAR MENSAJES PROPIOS
            // ===============================

            if (msg.key.fromMe) return;

            // ===============================
            // SOLO GRUPOS
            // ===============================

            const groupId =
                String(msg.key.remoteJid || '');

            if (!groupId.endsWith('@g.us')) return;

            // ===============================
            // DATOS
            // ===============================

            const senderId =
                String(msg.key.participant || msg.key.remoteJid || '');

            const text =
                String(msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text || '')
                    .toLowerCase()
                    .trim();

            // ===============================
            // DEBUG
            // ===============================

            if (DEBUG_MODE) {

                console.log('\n========================');

                console.log('📩 MENSAJE');

                console.log('GRUPO ID:', groupId);

                console.log('USUARIO:', senderId);

                console.log('MENSAJE:', text);

                console.log('========================\n');
            }

            // ===============================
            // FILTRO DE GRUPOS
            // ===============================

            const groupAllowed =

                ALLOWED_GROUPS.length === 0 ||

                ALLOWED_GROUPS.includes(groupId);

            if (!groupAllowed) {

                console.log(
                    '🚫 Grupo NO autorizado'
                );

                return;
            }

            console.log(
                '✅ Grupo autorizado'
            );

            // ===============================
            // FILTRO DE USUARIOS
            // ===============================

            // Vacío = TODOS los usuarios
            if (ALLOWED_USERS.length === 0) {

                console.log(
                    '✅ Usuario autorizado (todos)'
                );

            } else {

                if (!isUserAllowed(senderId)) {

                    console.log(
                        '🚫 Usuario NO autorizado'
                    );

                    return;
                }

                console.log(
                    '✅ Usuario autorizado'
                );

                if (DEBUG_MODE) {

                    console.log(
                        'USUARIO NORMALIZADO:',
                        toDigits(senderId)
                    );
                }
            }

            // ===============================
            // PALABRAS CLAVE
            // ===============================

            const detected =
                KEYWORDS.some(word =>
                    text.includes(word)
                );

            if (!detected) return;

            console.log(
                '🚨 Keyword detectada'
            );

            // ===============================
            // DELAY HUMANO (jitter)
            // ===============================

            await delay(1200, 2500);

            // ===============================
            // RESPUESTA VARIADA
            // ===============================

            const reply = pickReply();

            if (DEBUG_MODE) {
                console.log(
                    'RESPUESTA ELEGIDA:',
                    reply
                );
            }

            await sock.sendMessage(
                groupId,
                { text: reply },
                { quoted: msg }
            );

            console.log(
                '✅ RESPUESTA ENVIADA'
            );

        } catch (err) {

            console.log(
                '\n❌ ERROR\n'
            );

            console.log(err);
        }
    });

    return sock;
};

// ======================================
// SERVIDOR WEB (health + QR)
// ======================================

const startWebServer = require('./web');

startWebServer({
    getQr
});

// ======================================
// SHUTDOWN
// ======================================

let sockRef = null;

const shutdown = async () => {

    console.log('\n🛑 Deteniendo bot...');

    if (sockRef) {
        try {
            await sockRef.end();
        } catch (e) {
            // ignorar
        }
    }

    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ======================================
// START
// ======================================

start()
    .then((sock) => {
        sockRef = sock;
    })
    .catch((err) => {

        console.log(
            '\n❌ ERROR AL INICIAR\n'
        );

        console.log(err);

        process.exit(1);
    });
