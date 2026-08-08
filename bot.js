// ======================================
// IMPORTS
// ======================================

require('dotenv').config();

const qrcode = require('qrcode-terminal');

const { Client, LocalAuth } = require('whatsapp-web.js');

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

// DEBUG (true/false)
const DEBUG_MODE = toBool(process.env.DEBUG_MODE ?? 'true');

// ======================================
// GRUPOS AUTORIZADOS
// ======================================

// CSV. Si vacío = TODOS los grupos
const ALLOWED_GROUPS = splitCsv(process.env.ALLOWED_GROUPS);

// ======================================
// USUARIOS AUTORIZADOS
// ======================================

// CSV. Acepta 3 formatos (con código de país):
//   1) Número de teléfono          -> '521234567890'
//   2) ID clásico                  -> '521234567890@c.us'
//   3) ID LinkedIn (multi-device)  -> '2839174721783@lid'
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
// CHROME
// ======================================

const CHROME_PATH =
    process.env.CHROME_PATH ||
    (process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome-stable');

// ======================================
// CLIENTE
// ======================================

const client = new Client({

    authStrategy: new LocalAuth(),

    puppeteer: {

        headless: true,

        executablePath: CHROME_PATH,

        args: [

            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run',
            '--disable-component-update',
            '--disable-default-apps'

        ]
    }
});

// ======================================
// NORMALIZACIÓN DE USUARIOS
// ======================================

// Extrae solo dígitos (quita '+', espacios, '-', etc.)
const toDigits = (value) =>
    String(value || '')
        .replace(/\D+/g, '');

// IDs completos (contienen '@'): @c.us y @lid
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
// normalizando LID / @c.us a número de teléfono.
const isUserAllowed = async (msg) => {

    const author = (msg.author || '')
        .toLowerCase()
        .trim();

    // 1) Match directo con ID completo (@c.us / @lid)
    if (allowedIds.has(author)) {
        return { allowed: true, numbers: [] };
    }

    // 2) Resolver contacto -> número de teléfono
    try {
        const contact = await msg.getContact();

        const candidates = [
            toDigits(contact.number),
            toDigits(
                typeof contact.id === 'string'
                    ? contact.id
                    : contact.id?._serialized
            )
        ].filter(Boolean);

        if (candidates.some((n) => allowedNumbers.has(n))) {
            return { allowed: true, numbers: candidates };
        }
    } catch (e) {
        // sin contacto en caché
    }

    // 3) Fallback: forzar resolución LID -> teléfono
    try {
        const result = await client.pupPage.evaluate(
            (userId) => window.WWebJS.enforceLidAndPnRetrieval(userId),
            msg.author || msg.from
        );

        if (result && result.phone) {
            const digits = toDigits(
                result.phone?._serialized || result.phone
            );

            if (allowedNumbers.has(digits)) {
                return { allowed: true, numbers: [digits] };
            }
        }
    } catch (e) {
        // no se pudo resolver
    }

    return { allowed: false, numbers: [] };
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
// QR (también capturado para el servidor web)
// ======================================

let latestQr = null;

client.on('qr', qr => {

    latestQr = qr;

    console.log('\n📱 ESCANEA QR:\n');

    qrcode.generate(qr, {
        small: true
    });
});

// ======================================
// LOADING / READY
// ======================================

client.on('loading_screen', (percent, message) => {

    console.log(
        `⏳ Cargando WhatsApp: ${percent}% ${message || ''}`
    );
});

client.on('ready', () => {

    console.log('\n✅ BOT CONECTADO\n');
});

// ======================================
// RECONEXIÓN
// ======================================

const reconnect = async (attempt = 1) => {

    const wait =
        Math.min(1000 * 2 ** attempt, 60000);

    console.log(
        `🔄 Reintentando conexión en ${Math.round(wait / 1000)}s...`
    );

    await new Promise((resolve) =>
        setTimeout(resolve, wait)
    );

    try {
        await client.initialize();
    } catch (err) {
        console.log(
            '❌ Error en initialize:',
            err.message
        );
        await reconnect(attempt + 1);
    }
};

client.on('disconnected', async (reason) => {

    console.log(
        `\n⚠️ DESCONECTADO: ${reason}\n`
    );

    await reconnect();
});

client.on('auth_failure', async (msg) => {

    console.log(
        `\n❌ FALLO DE AUTENTICACIÓN: ${msg}\n`
    );

    await reconnect();
});

// ======================================
// MENSAJES
// ======================================

client.on('message_create', async (msg) => {

    try {

        // ===============================
        // IGNORAR MENSAJES PROPIOS
        // ===============================

        if (msg.fromMe) return;

        // ===============================
        // CHAT
        // ===============================

        const chat =
            await msg.getChat();

        const isGroup =
            chat.isGroup;

        // ===============================
        // SOLO GRUPOS
        // ===============================

        if (!isGroup) return;

        // ===============================
        // DATOS
        // ===============================

        const groupId =
            (chat.id._serialized || '')
                .trim();

        const senderId =
            (msg.author || '')
                .trim();

        const text =
            (msg.body || '')
                .toLowerCase()
                .trim();

        // ===============================
        // DEBUG
        // ===============================

        if (DEBUG_MODE) {

            console.log('\n========================');

            console.log('📩 MENSAJE');

            console.log(
                'GRUPO:',
                chat.name
            );

            console.log(
                'GRUPO ID:',
                groupId
            );

            console.log(
                'USUARIO:',
                senderId
            );

            console.log(
                'MENSAJE:',
                text
            );

            console.log('========================\n');
        }

        // ===============================
        // FILTRO DE GRUPOS
        // ===============================

        const groupAllowed =

            ALLOWED_GROUPS.length === 0 ||

            ALLOWED_GROUPS.includes(
                groupId
            );

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

            const result =
                await isUserAllowed(msg);

            if (!result.allowed) {

                console.log(
                    '🚫 Usuario NO autorizado'
                );

                return;
            }

            console.log(
                '✅ Usuario autorizado'
            );

            if (
                DEBUG_MODE &&
                result.numbers.length
            ) {

                console.log(
                    'USUARIO NORMALIZADO:',
                    result.numbers.join(' | ')
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

        await msg.reply(
            reply
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

// ======================================
// SERVIDOR WEB (health + QR)
// ======================================

const startWebServer = require('./web');

startWebServer({
    getQr: () => latestQr
});

// ======================================
// SHUTDOWN
// ======================================

process.on('SIGINT', async () => {

    console.log('\n🛑 Deteniendo bot...');

    try {
        await client.destroy();
    } catch (e) {
        // ignorar
    }

    process.exit(0);
});

// ======================================
// START
// ======================================

client.initialize().catch((err) => {

    console.log(
        '\n❌ ERROR AL INICIAR\n'
    );

    console.log(err);

    process.exit(1);
});
