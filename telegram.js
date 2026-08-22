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

const TELEGRAM_POLL = String(process.env.TELEGRAM_POLL || 'true').toLowerCase() === 'true';
const MY_ROLE = (process.env.BOT_ROLE || 'trabajo').toLowerCase().trim();

const PEER_URL = (process.env.PEER_URL || '').replace(/\/+$/, '');
const PEER_ROLE = (process.env.PEER_ROLE || '').toLowerCase().trim();
const PEER_TOKEN = process.env.PEER_TOKEN || process.env.QR_TOKEN || '';

const getTelegramConfig = () => ({
    token: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    allowedIds: ALLOWED_IDS,
    poll: TELEGRAM_POLL,
    role: MY_ROLE
});

// ======================================
// API BASE
// ======================================

const apiBase = () =>
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

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
            const err = new Error(`Telegram ${method} falló: ${(data && data.description) || `HTTP ${res.status}`}`);
            err.status = res.status;
            err.description = data && data.description;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
};

const sendTelegramPhoto = async (chatId, buffer, caption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buffer], { type: 'image/png' }), 'qr.png');
    if (caption) form.append('caption', caption);
    const res = await fetch(`${apiBase()}/sendPhoto`, { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
        throw new Error(`Telegram sendPhoto falló: ${(data && data.description) || `HTTP ${res.status}`}`);
    }
    return data;
};

// ======================================
// PEER ROUTING (Llamadas a la otra instancia)
// ======================================

const peerFetch = async (path, params = {}, timeoutMs = 75000) => {
    if (!PEER_URL) throw new Error('No hay PEER_URL configurada');
    const query = new URLSearchParams({ token: PEER_TOKEN, ...params }).toString();
    const url = `${PEER_URL}${path}?${query}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Peer respondió HTTP ${res.status}: ${txt.slice(0, 100)}`);
    }
    return res;
};

// ======================================
// CONTROL (comandos del usuario)
// ======================================

let handlers = null;

const setHandlers = (opts) => { handlers = opts; };

const reply = async (chatId, text) => {
    try { await telegramApi('sendMessage', { chat_id: chatId, text }); } 
    catch (err) { console.log(`[telegram] no pude responder: ${err.message}`); }
};

const parseCommand = (text) => {
    const m = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text || '').trim());
    if (!m) return null;
    const name = m[1].toLowerCase();
    let args = (m[2] || '').trim();
    
    // Extraer destino si es el primer argumento
    let dest = MY_ROLE;
    const parts = args.split(/\s+/);
    const firstArg = parts[0].toLowerCase();
    
    if (firstArg === MY_ROLE || (PEER_ROLE && firstArg === PEER_ROLE)) {
        dest = firstArg;
        args = parts.slice(1).join(' ').trim();
    }
    
    return { name, args, dest };
};

const HELP_TEXT = [
    '🤖 WSbot — Comandos:',
    '(Destino: trabajo | personal, por defecto trabajo)',
    '/help — esta ayuda',
    '/status — estado de ambas instancias',
    '/qr [destino] — muestra el QR para vincular',
    '/logs [destino] [N] — últimas N líneas de logs',
    '/desconectar [destino] — borra sesión y vuelve al modo espera'
].join('\n');

const buildStatus = (d, label) => {
    const uptimeMin = Math.floor((d.uptimeSec || 0) / 60);
    const fmt = (ts) => ts ? new Date(ts).toLocaleString() : '—';
    const roleTag = label ? `[${label.toUpperCase()}] ` : '';
    return [
        `🤖 Estado del bot ${roleTag}:`,
        `• Conectado: ${d.connected ? 'SÍ ✅' : 'NO ❌'}`,
        `• Sesión registrada: ${d.sessionRegistered ? 'SÍ' : 'NO'}`,
        `• Estado Baileys: ${d.lastStatus || '—'}`,
        `• Última QR: ${fmt(d.lastQrAt)}`,
        `• Uptime: ${uptimeMin} min`
    ].join('\n');
};

const handleUpdate = async (update) => {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return;
    const chatId = msg.chat && msg.chat.id;
    if (!chatId) return;

    const cmd = parseCommand(msg.text);
    if (!cmd) return;

    const fromId = String((msg.from && msg.from.id) || '');
    const isMainGroup = String(chatId) === String(TELEGRAM_CHAT_ID);

    // /help y /start son públicos; el resto requiere autorización (ID o grupo)
    if (cmd.name === 'help' || cmd.name === 'start') {
        return reply(chatId, HELP_TEXT);
    }

    if (!isMainGroup && !ALLOWED_IDS.includes(fromId)) {
        console.log(`[telegram] comando '${cmd.name}' de ${fromId} NO autorizado`);
        return;
    }

    // Ruta a la instancia destino
    if (cmd.dest === MY_ROLE) {
        switch (cmd.name) {
            case 'status': {
                const local = handlers.getDebug();
                await reply(chatId, buildStatus(local, MY_ROLE));
                if (PEER_URL) {
                    try {
                        const r = await peerFetch('/debug');
                        const remote = await r.json();
                        await reply(chatId, buildStatus(remote, PEER_ROLE));
                    } catch (e) {
                        await reply(chatId, `⚠️ [${PEER_ROLE.toUpperCase()}] sin respuesta (¿dormida? reintenta en ~1min)`);
                    }
                }
                return;
            }
            case 'qr': {
                const debug = handlers.getDebug();
                if (debug.connected) return reply(chatId, '✅ Ya estoy conectado a WhatsApp.');
                const qr = handlers.getQr();
                if (qr) {
                    const buf = await qrcode.toBuffer(qr, { width: 512, margin: 1 });
                    return sendTelegramPhoto(chatId, buf, '📱 Escanea para vincular TRABAJO.');
                }
                reply(chatId, 'Generando QR de Trabajo…');
                return handlers.startQrSession(chatId);
            }
            case 'logs': {
                const n = Math.min(Math.max(parseInt(cmd.args || '20', 10) || 20, 1), 50);
                const out = handlers.getLogs(n);
                return reply(chatId, `📋 Logs de TRABAJO:\n${out.slice(-3500)}`);
            }
            case 'desconectar': {
                reply(chatId, '🚪 Desconectando TRABAJO…');
                return handlers.disconnectBot();
            }
            default: return reply(chatId, 'Comando desconocido.');
        }
    } else {
        // COMANDOS PARA PEER
        if (!PEER_URL) return reply(chatId, '⚠️ No hay otra instancia configurada.');
        const peerLabel = PEER_ROLE.toUpperCase();
        
        switch (cmd.name) {
            case 'status':
                try {
                    const r = await peerFetch('/debug');
                    const data = await r.json();
                    return reply(chatId, buildStatus(data, PEER_ROLE));
                } catch (e) {
                    return reply(chatId, `⚠️ [${peerLabel}] no responde: ${e.message}`);
                }
            case 'qr':
                try {
                    const r = await peerFetch('/qr-remote', { chat_id: chatId });
                    const txt = await r.text();
                    if (txt === 'connected') return reply(chatId, `✅ ${peerLabel} ya está conectado.`);
                    return reply(chatId, `📱 QR de ${peerLabel} solicitado...`);
                } catch (e) {
                    return reply(chatId, `❌ No pude pedir el QR a ${peerLabel}: ${e.message}`);
                }
            case 'logs':
                try {
                    const n = Math.min(Math.max(parseInt(cmd.args || '20', 10) || 20, 1), 50);
                    const r = await peerFetch('/logs', { lines: n });
                    const out = await r.text();
                    return reply(chatId, `📋 Logs de ${peerLabel}:\n${out.slice(-3500)}`);
                } catch (e) {
                    return reply(chatId, `❌ Error leyendo logs de ${peerLabel}: ${e.message}`);
                }
            case 'desconectar':
                try {
                    await reply(chatId, `🚪 Desconectando ${peerLabel}...`);
                    await peerFetch('/restart');
                    return reply(chatId, `✅ ${peerLabel} desconectado correctamente.`);
                } catch (e) {
                    return reply(chatId, `❌ Error al desconectar ${peerLabel}: ${e.message}`);
                }
            default: return reply(chatId, 'Comando desconocido.');
        }
    }
};

let offset = 0;
let pollingStopped = false;

const poll = async () => {
    try {
        const url = `${apiBase()}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message"]`;
        const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
        const data = await res.json().catch(() => null);
        if (data && data.ok) {
            for (const u of data.result || []) {
                offset = u.update_id + 1;
                handleUpdate(u).catch(e => console.error('[tg] error handling update:', e));
            }
        }
    } catch (err) { console.log(`[telegram] polling error: ${err.message}`); }
    if (!pollingStopped) setTimeout(poll, 1500);
};

const checkBoot = async () => {
    if (!TELEGRAM_BOT_TOKEN) return console.log('[telegram] TELEGRAM_BOT_TOKEN no configurado');
    try {
        const me = await telegramApi('getMe', {});
        console.log(`[telegram] bot @${me.result.username} OK | modo: ${TELEGRAM_POLL ? 'LÍDER' : 'SEGUIDOR'} | peer: ${PEER_ROLE || 'ninguno'}`);
    } catch (err) { console.log(`[telegram] getMe falló: ${err.message}`); }
};

module.exports = function startTelegram(options) {
    setHandlers(options);
    if (!TELEGRAM_BOT_TOKEN) return;
    checkBoot();
    if (TELEGRAM_POLL) poll();
    else console.log('[telegram] Polling desactivado (instancia seguidora)');
    return { telegramApi, sendTelegramPhoto, getTelegramConfig };
};