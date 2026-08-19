// ======================================
// IMPORTS
// ======================================

require('dotenv').config();

const util = require('util');

const fs = require('fs');

const pino = require('pino');

const {
    useMultiFileAuthState,
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

// ======================================
// CAPTURA DE LOGS (para el endpoint /logs)
// ======================================

const logHistory = [];

const LOG_HISTORY_MAX = 500;

let pendingLine = '';

const nowStamp = () => {

    const d = new Date();

    const p = (n) => String(n).padStart(2, '0');

    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
};

const pushLogLine = (line) => {

    logHistory.push(line);

    if (logHistory.length > LOG_HISTORY_MAX) {
        logHistory.splice(0, logHistory.length - LOG_HISTORY_MAX);
    }
};

const captureStream = (stream) => {

    const orig = stream.write.bind(stream);

    stream.write = (chunk, encoding, cb) => {

        const text =
            Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk);

        const lines = (pendingLine + text).split('\n');

        pendingLine = lines.pop() || '';

        for (const l of lines) {
            pushLogLine(`${nowStamp()} ${l}`);
        }

        return orig(chunk, encoding, cb);
    };
};

captureStream(process.stdout);
captureStream(process.stderr);

const getLogs = (n) => {

    const lines = logHistory.slice(-n);

    if (pendingLine) lines.push(`${nowStamp()} ${pendingLine}`);

    return lines.join('\n');
};

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
// DELAY DE RESPUESTA (ms). 0 = instantáneo
// ======================================

const REPLY_DELAY_MIN = Math.max(
    0,
    parseInt(process.env.REPLY_DELAY_MIN || '0', 10) || 0
);

const REPLY_DELAY_MAX = Math.max(
    0,
    parseInt(process.env.REPLY_DELAY_MAX || '0', 10) || 0
);

// ======================================
// NOTIFICACIONES (ntfy, con antispam)
// ======================================

const NOTIFY_URL = process.env.NOTIFY_URL || '';

// Avisar cuando el bot responde (solo nombre del grupo)
const NOTIFY_REPLY = toBool(process.env.NOTIFY_REPLY ?? 'false');

// Recordatorio de QR sin escanear: 1ª vez inmediato, luego cada 5h
const QR_NOTIFY_INTERVAL = 5 * 60 * 60 * 1000;

// Reconexión: avisar tras 5 fallos seguidos, luego 1 vez por hora
const RECONNECT_NOTIFY_AFTER = 5;

const RECONNECT_NOTIFY_INTERVAL = 60 * 60 * 1000;

let reconnectFailCount = 0;

const lastNotifyAt = {};

const notify = (title, body, opts = {}) => {

    if (!NOTIFY_URL) return;

    const { priority = 'default', tags = '' } = opts;

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), 3000);

    fetch(NOTIFY_URL, {
        method: 'POST',
        headers: {
            Title: title,
            Priority: priority,
            Tags: tags
        },
        body,
        signal: controller.signal
    })
        .catch(() => { /* sin red: ignorar */ })
        .finally(() => clearTimeout(timer));
};

// Notifica respetando cooldown por clave (antispam)
const notifyCooldown = (key, intervalMs, title, body, opts) => {

    const last = lastNotifyAt[key] || 0;

    if (Date.now() - last < intervalMs) return;

    lastNotifyAt[key] = Date.now();

    notify(title, body, opts);
};

const notifyReset = (key) => {
    delete lastNotifyAt[key];
};

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

// Mapa LID -> número de teléfono (Baileys entrega remitentes como
// @lid; el número real llega via 'contacts.update').
const lidPns = new Map();

// Resuelve si un remitente está autorizado, soportando:
//   '521234567890@c.us' (formato usado en ALLOWED_USERS),
//   '521234567890@s.whatsapp.net' y LID '2839174721783@lid'.
const isUserAllowed = (author) => {

    const id = String(author || '')
        .toLowerCase()
        .trim();

    if (!id) return false;

    // 1) Match directo con ID completo (@c.us / @s.whatsapp.net / @lid)
    if (allowedIds.has(id)) {
        return true;
    }

    const candidates = [];

    // 2) Si es LID, resolver primero a número de teléfono real
    if (id.endsWith('@lid')) {

        const pn = lidPns.get(id);

        if (pn) {
            candidates.push(String(pn).toLowerCase().trim());
        }
    }

    // 3) El propio ID (los dígitos funcionan para @c.us / @s.whatsapp.net)
    candidates.push(id);

    const matches = candidates

        .map(toDigits)

        .filter(Boolean)

        .filter((n) => allowedNumbers.has(n));

    return matches.length > 0;
};

// Devuelve el número real (si el remitente es LID) para logs/diagnóstico
const lidToPhone = (author) => {

    const id = String(author || '')
        .toLowerCase()
        .trim();

    return id.endsWith('@lid') ? lidPns.get(id) : null;
};

// Resuelve LID -> número real usando los metadatos del grupo
// (caché de 2 min por grupo, para no spamear a WhatsApp).
const groupLidCache = new Map();

const ensureGroupLidMap = async (sock, groupId) => {

    const last = groupLidCache.get(groupId) || 0;

    if (Date.now() - last < 120000) return;

    try {

        const meta = await sock.groupMetadata(groupId);

        if (meta?.subject) {
            groupNames.set(groupId, { name: meta.subject, ts: Date.now() });
        }

        for (const p of meta?.participants || []) {

            if (!p.lid) continue;

            // 'jid' es el PN-jid; 'id' puede ser el mismo PN o el LID
            const resolvedJid = p.jid || p.id || '';

            if (resolvedJid) {

                lidPns.set(
                    String(p.lid).toLowerCase().trim(),
                    String(resolvedJid).trim()
                );
            }
        }

        groupLidCache.set(groupId, Date.now());

    } catch (e) {

        // sin permiso o error de red: reintentar en ~1 min
        groupLidCache.set(groupId, Date.now() - 115000);
    }
};

// Caché de nombres de grupo (groupId -> { name, ts }), TTL 1h
const groupNames = new Map();

const GROUP_NAME_TTL = 60 * 60 * 1000;

const getGroupName = async (sock, groupId) => {

    const cached = groupNames.get(groupId);

    if (cached && Date.now() - cached.ts < GROUP_NAME_TTL) {
        return cached.name;
    }

    try {

        const meta = await sock.groupMetadata(groupId);

        const name = meta?.subject || groupId;

        groupNames.set(groupId, { name, ts: Date.now() });

        return name;

    } catch (e) {

        return groupId;
    }
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
// DELAY (jitter configurable; default 0 = sin espera)
// ======================================

const delay = (min, max) => {

    const lo = Math.min(min, max);

    const hi = Math.max(min, max);

    const ms = lo + Math.random() * (hi - lo);

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
// ESTADO DE DIAGNÓSTICO (para /debug)
// ======================================

let lastStatus = null;

let lastQrAt = null;

let lastCloseAt = null;

let lastCloseError = null;

let currentRegistered = false;

const bootAt = Date.now();

// Formatea el error de desconexión para /debug sin datos sensibles
const formatCloseError = (err) => {

    if (!err) return null;

    const statusCode =
        err.output?.statusCode;

    return {
        statusCode:
            statusCode ?? null,
        message:
            err.message || String(err),
        output_payload:
            err.output?.payload ||
            undefined
    };
};

const getDebug = () => ({

    uptimeSec:
        Math.round(process.uptime()),

    bootAt:
        new Date(bootAt).toISOString(),

    connected:
        lastStatus === 'open',

    lastStatus,

    lastQrAt,

    lastCloseAt,

    lastCloseError,

    sessionRegistered:
        currentRegistered,

    sessionPath: SESSION_PATH,

    debugMode: DEBUG_MODE,

    node:

        process.version,

    port: process.env.PORT || 7860
});

// ======================================
// CLIENTE (Baileys)
// ======================================

let reconnecting = false;

let reconnectAttempt = 0;

let reconnectTimer = null;

const start = async () => {

    const { state, saveCreds } =
        await useMultiFileAuthState(SESSION_PATH);

    const { version } =
        await fetchLatestBaileysVersion();

    const sock = makeWASocket({

        version,

        auth: state,

        // Logger de Baileys: 'error' por defecto (captura causas reales
        // sin spam); 'info' con detalle si DEBUG_MODE=true
        logger: pino({ level: DEBUG_MODE ? 'info' : 'error' }),

        browser: ['WSbot', 'Chrome', '151'],

        markOnlineOnConnect: false,

        syncFullHistory: false,

        // Evita prefetch de contactos/sesiones innecesarios
        downloadHistory: false,

        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', (creds) => {

        saveCreds(creds);

        if (creds.registered !== undefined) {
            currentRegistered = creds.registered === true;
            console.log('[sock] sesión registrada =', currentRegistered);
        }
    });

    // Baileys entrega remitentes de grupo como LID. El número real
    // se aprende de: contacts.upsert/update, chats.phoneNumberShare
    // y (garantizado) de groupMetadata(). Lo guardamos en el mapa LID->PN.
    const setLid = (lid, jid) => {

        if (!lid || !jid) return;

        lidPns.set(
            String(lid).toLowerCase().trim(),
            String(jid).trim()
        );
    };

    sock.ev.on('contacts.update', (contacts) => {

        for (const c of contacts || []) {
            if (c.lid) setLid(c.lid, c.jid || c.id);
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {

        for (const c of contacts || []) {
            if (c.lid) setLid(c.lid, c.jid || c.id);
        }
    });

    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
        setLid(lid, jid);
    });

    console.log(
        `\n[Boot] Baileys OK | WA version ${version} | sesión registrada: ${state.creds.registered === true}\n`
    );

    // ===============================
    // CONNECTION
    // ===============================

    sock.ev.on('connection.update', (update) => {

        const { connection, lastDisconnect, qr } = update;

        lastStatus = connection || 'connecting';

        if (qr) {

            latestQr = qr;

            lastQrAt = Date.now();

            if (DEBUG_MODE) {
                console.log(
                    '[sock] evento: QR recibido'
                );
            }

            console.log(
                '\n📱 QR generado. Escanea en /qr (con QR_TOKEN)\n'
            );

            return;
        }

        if (connection === 'open') {

            latestQr = null;

            reconnectAttempt = 0;

            reconnectFailCount = 0;

            notifyReset('session');

            notifyReset('reconnect');

            console.log(
                '\n✅ BOT CONECTADO\n'
            );

            return;
        }

        if (connection === 'close') {

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const isLoggedOut =
                statusCode === DisconnectReason.loggedOut;

            // En timeouts/errores de red (408), el QR pendiente sigue
            // vinculado a esta sesión: NO borrarlo para que el escaneo
            // pueda completarse cuando el ws se re-establezca.
            if (isLoggedOut) {
                latestQr = null;
            }

            lastCloseAt = Date.now();

            lastCloseError =
                formatCloseError(lastDisconnect?.error);

            console.log(
                '\n🛑 CONEXIÓN CERRADA'
            );

            console.log(
                'statusCode =',
                statusCode
            );

            console.log(
                'isLoggedOut =',
                isLoggedOut
            );

            // Causa real que reporta Baileys (no ocultamos nada)
            console.error(
                '\n--- DETALLE ERROR ---'
            );

            console.error(
                util.inspect(
                    lastDisconnect?.error || {},
                    { depth: 4, colors: false }
                )
            );

            console.error(
                '--- FIN DETALLE ---\n'
            );

            if (isLoggedOut) {

                console.log(
                    '\n🚨 Sesión cerrada (loggedOut). Re-escanea el QR en /qr (o quita dispositivos viejos)\n'
                );

            } else {

                console.log(
                    '\n⚠️ Conexión cerrada. Reconectando...\n'
                );
            }

            if (reconnecting) return;

            // Notificación de sesión/QR (1ª vez inmediato, luego cada 5h)
            if (!currentRegistered || isLoggedOut) {

                notifyCooldown(
                    'session',
                    QR_NOTIFY_INTERVAL,
                    !currentRegistered
                        ? '🚨 Bot sin escanear'
                        : '🚨 Sesión cerrada (logout)',
                    'Re-escanea el QR en /qr cuando quieras.',
                    { priority: 'high', tags: 'warning' }
                );
            }

            // Reconexión fallando: tras N fallos, luego 1 vez por hora
            reconnectFailCount += 1;

            if (reconnectFailCount >= RECONNECT_NOTIFY_AFTER) {

                notifyCooldown(
                    'reconnect',
                    RECONNECT_NOTIFY_INTERVAL,
                    '⚠️ Reconexión fallando',
                    `${reconnectFailCount} intentos de reconexión sin éxito.`,
                    { tags: 'warning' }
                );
            }

            reconnecting = true;

            // Backoff capado (se reinicia al lograr conexión)
            const attempt =
                reconnectAttempt > 0
                    ? reconnectAttempt
                    : 1;

            const wait =
                Math.min(5000 * 2 ** (attempt - 1), 60000);

            reconnectAttempt += 1;

            console.log(
                `🔄 Reconectando en ${Math.round(wait / 1000)}s...`
            );

            reconnectTimer = setTimeout(() => {

                reconnecting = false;

                start()
                    .then((sock) => {
                        sockRef = sock;
                    })
                    .catch((err) => {

                        console.log(
                            '\n❌ Error al reconectar\n'
                        );

                        console.log(err);
                    });
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

            const receivedAt = Date.now();

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

            // Resolver LID -> número solo si el remitente es @lid y
            // todavía no conocemos su número real (fuera de la ruta caliente)
            const lid = senderId.toLowerCase().trim();

            if (lid.endsWith('@lid') && !lidPns.has(lid)) {
                await ensureGroupLidMap(sock, groupId);
            }

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

                    const resolved =

                        lidToPhone(senderId);

                    console.log(
                        'USUARIO NORMALIZADO:',
                        toDigits(senderId),
                        resolved
                            ? `| LID -> PN: ${resolved}`
                            : ''
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
            // DELAY DE RESPUESTA (0 por defecto = instantáneo)
            // ===============================

            if (REPLY_DELAY_MAX > 0) {

                await delay(
                    REPLY_DELAY_MIN,
                    REPLY_DELAY_MAX
                );
            }

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

            if (NOTIFY_REPLY) {

                const groupName = await getGroupName(sock, groupId);

                notify(
                    '📨 Bot respondió',
                    `Respondí en "${groupName}".`,
                    { tags: 'speech_balloon' }
                );
            }

            if (DEBUG_MODE) {
                console.log(
                    `⏱️ Latencia recepción→respuesta: ${Date.now() - receivedAt}ms`
                );
            }

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

// ======================================
// SHUTDOWN
// ======================================

let sockRef = null;

const shutdown = async () => {

    console.log('\n🛑 Deteniendo bot...');

    notify(
        '🛑 Bot detenido',
        'El proceso se detuvo (SIGTERM/SIGINT): hibernación, deploy o reinicio de Render.'
    );

    if (sockRef) {
        try {
            await sockRef.end();
        } catch (e) {
            // ignorar
        }
    }

    // Dar tiempo a que salga el POST de notificación
    await delay(1500, 1500);

    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ======================================
// REINICIO EN-PROCESO (sin matar la instancia)
// ======================================

const restartBot = async () => {

    console.log('\n♻️ Reiniciando bot (sesión nueva)...\n');

    notify(
        '♻️ Reinicio solicitado',
        'El bot se reinició y la sesión se borró. Re-escanea el QR en /qr cuando quieras.'
    );

    reconnecting = true;

    // Cancelar cualquier reconexión pendiente: /restart gana siempre
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (sockRef) {
        try {
            await sockRef.end();
        } catch (e) {
            // ignorar
        }
        sockRef = null;
    }

    // Esperar a que el ws cierre del todo
    await delay(1000, 1000);

    // Sesión nueva: borrar credenciales para forzar re-escaneo
    try {

        fs.rmSync(SESSION_PATH, { recursive: true, force: true });

        console.log('[restart] sesión eliminada:', SESSION_PATH);

    } catch (e) {

        console.log('[restart] no se pudo borrar la sesión:', e.message);
    }

    latestQr = null;
    reconnectAttempt = 0;
    reconnectFailCount = 0;
    lidPns.clear();
    groupLidCache.clear();
    groupNames.clear();
    notifyReset('session');
    notifyReset('reconnect');

    reconnecting = false;

    await boot();
};

// ======================================
// START
// ======================================

const boot = async () => {

    try {

        sockRef = await start();

    } catch (err) {

        console.log(
            '\n❌ ERROR AL INICIAR\n'
        );

        console.log(err);

        // Reintentar sin matar la instancia
        setTimeout(boot, 5000);
    }
};

startWebServer({
    getQr,
    getDebug,
    getLogs,
    getRestart: restartBot
});

boot();
