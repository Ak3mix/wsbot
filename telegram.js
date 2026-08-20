// ======================================
// TELEGRAM: notificaciones + control del bot
// ======================================

const qrcode = require('qrcode');

// ======================================
// CONFIG (variables de entorno)
// ======================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const ALLOWED_IDS = String(process.env.TELEGRAM_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const getTelegramConfig = () => ({
    token: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    allowedIds: ALLOWED_IDS
});

// ======================================
// API BASE
// ======================================

const apiBase = () =>
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Llama a un método de la API de Telegram con body JSON.
// Lanza error con .status y .description si la API responde mal.
const telegramApi = async (method, payload = {}) => {

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), 15000);

    try {

        const res = await fetch(`${apiBase()}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data || data.ok !== true) {

            const err = new Error(
                `Telegram ${method} falló: ${(data && data.description) || `HTTP ${res.status}`}`
            );

            err.status = res.status;

            err.description = data && data.description;

            throw err;
        }

        return data;

    } finally {

        clearTimeout(timer);
    }
};

// Envía una foto (multipart). Útil para el QR.
const sendTelegramPhoto = async (chatId, buffer, caption) => {

    const form = new FormData();

    form.append('chat_id', String(chatId));

    form.append(
        'photo',
        new Blob([buffer], { type: 'image/png' }),
        'qr.png'
    );

    if (caption) form.append('caption', caption);

    const res = await fetch(`${apiBase()}/sendPhoto`, {
        method: 'POST',
        body: form
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok !== true) {
        throw new Error(
            `Telegram sendPhoto falló: ${(data && data.description) || `HTTP ${res.status}`}`
        );
    }

    return data;
};

// ======================================
// CONTROL (comandos del usuario)
// ======================================

let handlers = null;

const setHandlers = (opts) => {
    handlers = opts;
};

const reply = async (chatId, text) => {

    try {

        await telegramApi('sendMessage', { chat_id: chatId, text });

    } catch (err) {

        console.log(`[telegram] no pude responder: ${err.message}`);
    }
};

const parseCommand = (text) => {

    const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(
        String(text || '').trim()
    );

    if (!m) return null;

    return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
};

const HELP_TEXT = [
    '🤖 WSbot — Comandos:',
    '/help — esta ayuda',
    '/status — estado actual',
    '/qr — muestra el QR para vincular (o lo genera)',
    '/logs [N] — últimas N líneas de logs',
    '/desconectar — borra la sesión y pasa al modo espera'
].join('\n');

const buildStatus = () => {

    const d =
        typeof handlers.getDebug === 'function'
            ? handlers.getDebug()
            : {};

    const uptimeMin = Math.floor((d.uptimeSec || 0) / 60);

    const fmt = (ts) =>
        ts ? new Date(ts).toLocaleString() : '—';

    return [
        '🤖 Estado del bot:',
        `• Conectado: ${d.connected ? 'SÍ ✅' : 'NO ❌'}`,
        `• Sesión registrada: ${d.sessionRegistered ? 'SÍ' : 'NO'}`,
        `• Estado Baileys: ${d.lastStatus || '—'}`,
        `• Última QR: ${fmt(d.lastQrAt)}`,
        `• Último cierre: ${fmt(d.lastCloseAt)}`,
        `• Uptime: ${uptimeMin} min`,
        `• Modo debug: ${d.debugMode ? 'SÍ' : 'no'}`
    ].join('\n');
};

const handleQr = async (chatId) => {

    const debug =
        typeof handlers.getDebug === 'function'
            ? handlers.getDebug()
            : {};

    if (debug.connected) {
        return reply(chatId, '✅ Ya estoy conectado a WhatsApp.');
    }

    const qr =
        typeof handlers.getQr === 'function'
            ? handlers.getQr()
            : null;

    if (qr) {

        try {

            const buf = await qrcode.toBuffer(qr, { width: 512, margin: 1 });

            await sendTelegramPhoto(
                chatId,
                buf,
                '📱 Escanea este QR con WhatsApp para vincular.'
            );

        } catch (err) {

            reply(chatId, `No pude enviar el QR: ${err.message}`);
        }

        return;
    }

    reply(chatId, 'Generando QR…');

    try {

        if (typeof handlers.startQrSession === 'function') {
            await handlers.startQrSession(chatId);
        }

    } catch (err) {

        reply(chatId, `Error al generar QR: ${err.message}`);
    }
};

const handleLogs = async (chatId, args) => {

    const n = Math.min(
        Math.max(parseInt(args || '20', 10) || 20, 1),
        50
    );

    const out =
        typeof handlers.getLogs === 'function'
            ? handlers.getLogs(n)
            : 'Sin logs.';

    const lines = String(out).split('\n').filter(Boolean).slice(-30);

    let text = lines.join('\n');

    if (text.length > 3500) {
        text = '…\n' + text.slice(-3500);
    }

    return reply(chatId, `📋 Logs (últimas ${n} líneas):\n${text}`);
};

const handleDesconectar = async (chatId) => {

    reply(chatId, '🚪 Desconectando… borro la sesión y vuelvo al modo espera.');

    try {

        if (typeof handlers.disconnectBot === 'function') {
            await handlers.disconnectBot();
        }

    } catch (err) {

        reply(chatId, `Error al desconectar: ${err.message}`);
    }
};

const handleUpdate = (update) => {

    const msg = update.message;

    if (!msg || typeof msg.text !== 'string') return;

    const chatId = msg.chat && msg.chat.id;

    if (!chatId) return;

    const cmd = parseCommand(msg.text);

    if (!cmd) return;

    const fromId = String((msg.from && msg.from.id) || '');

    // /help y /start son públicos; el resto requiere autorización
    if (cmd.name === 'help' || cmd.name === 'start') {
        return reply(chatId, HELP_TEXT);
    }

    if (!ALLOWED_IDS.includes(fromId)) {

        console.log(
            `[telegram] comando '${cmd.name}' de ${fromId} NO autorizado`
        );

        return;
    }

    switch (cmd.name) {

        case 'status':
            return reply(chatId, buildStatus());

        case 'qr':
            return handleQr(chatId);

        case 'logs':
            return handleLogs(chatId, cmd.args);

        case 'desconectar':
            return handleDesconectar(chatId);

        default:
            return reply(chatId, 'Comando desconocido. Usa /help');
    }
};

// ======================================
// POLLING (long-poll de getUpdates)
// ======================================

let offset = 0;

let pollTimer = null;

let pollingStopped = false;

const poll = async () => {

    try {

        const url =
            `${apiBase()}/getUpdates` +
            `?offset=${offset}` +
            '&timeout=30' +
            '&allowed_updates=["message"]';

        const res = await fetch(url, {
            signal: AbortSignal.timeout(45000)
        });

        const data = await res.json().catch(() => null);

        if (data && data.ok) {

            for (const u of data.result || []) {

                offset = u.update_id + 1;

                handleUpdate(u);
            }
        }

    } catch (err) {

        console.log(`[telegram] polling error: ${err.message}`);
    }

    if (!pollingStopped) {
        pollTimer = setTimeout(poll, 1500);
    }
};

// ======================================
// ARRANQUE
// ======================================

const checkBoot = async () => {

    if (!TELEGRAM_BOT_TOKEN) {

        console.log('[telegram] TELEGRAM_BOT_TOKEN no configurado');

        return;
    }

    try {

        const me = await telegramApi('getMe', {});

        console.log(
            `[telegram] bot @${me.result.username} OK | chat_id: ${TELEGRAM_CHAT_ID || 'NO'} | allowed: ${ALLOWED_IDS.length ? ALLOWED_IDS.join(', ') : 'NADIE'}`
        );

    } catch (err) {

        console.log(`[telegram] getMe falló: ${err.message}`);
    }
};

module.exports = function startTelegram(options) {

    setHandlers(options);

    if (!TELEGRAM_BOT_TOKEN) {

        console.log('[telegram] control desactivado (sin TELEGRAM_BOT_TOKEN)');

        return;
    }

    checkBoot();

    poll();

    return {
        telegramApi,
        sendTelegramPhoto,
        getTelegramConfig
    };
};

module.exports.telegramApi = telegramApi;

module.exports.sendTelegramPhoto = sendTelegramPhoto;

module.exports.getTelegramConfig = getTelegramConfig;