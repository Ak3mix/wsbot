// ======================================
// SERVIDOR WEB (health check + QR en navegador)
// ======================================

const express = require('express');
const qrcode = require('qrcode');

module.exports = function startWebServer(options) {

    const { getQr, getDebug, getLogs } = options;

    const app = express();

    const port =
        process.env.PORT || 7860;

    const token =
        process.env.QR_TOKEN || '';

    const restartToken =
        process.env.RESTART_TOKEN || token || '';

    const logsToken =
        process.env.LOGS_TOKEN || token || '';

    // ===============================
    // HEALTH (target del keep-alive y de Render)
    // ===============================

    app.get('/health', (req, res) => {
        res.send('ok');
    });

    // ===============================
    // QR (fallback para sesión expirada)
    // ===============================

    app.get('/qr', async (req, res) => {

        if (token && req.query.token !== token) {
            return res.status(403).send('No autorizado');
        }

        const qr = getQr();

        if (!qr) {
            return res.status(404).send(
                'Sin QR disponible (sesión activa o conectando).'
            );
        }

        const dataUrl = await qrcode.toDataURL(qr);

        res.send(
            `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;text-align:center;padding-top:40px;">
<h2>Escanea con WhatsApp</h2>
<img src="${dataUrl}" width="260" height="260" style="image-rendering:pixelated;"/>
<p>WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo</p>
</body>
</html>`
        );
    });

    // ===============================
    // DEBUG (estado + último error de conexión)
    // ===============================

    app.get('/debug', (req, res) => {

        if (token && req.query.token !== token) {
            return res.status(403).send('No autorizado');
        }

        const debug =
            typeof getDebug === 'function'
                ? getDebug()
                : {};

        res.json({
            web: 'ok',
            ...debug
        });
    });

    // ===============================
    // RESTART (reinicio total -> Render crea instancia nueva -> re-escaneo)
    // ===============================

    app.all('/restart', (req, res) => {

        const t =
            req.query.token ||
            req.headers['x-restart-token'] ||
            '';

        if (restartToken && t !== restartToken) {
            return res.status(403).send('No autorizado');
        }

        console.log('♻️ Reinicio total solicitado');

        res.status(202).send(
            'Reiniciando bot. Re-escanea el QR en /qr'
        );

        setTimeout(() => process.exit(0), 300);
    });

    // ===============================
    // LOGS (últimas líneas de stdout/stderr)
    // ===============================

    app.get('/logs', (req, res) => {

        const t =
            req.query.token ||
            req.headers['x-logs-token'] ||
            '';

        if (logsToken && t !== logsToken) {
            return res.status(403).send('No autorizado');
        }

        const n = Math.min(
            parseInt(req.query.lines || '200', 10) || 200,
            1000
        );

        const out =
            typeof getLogs === 'function'
                ? getLogs(n)
                : '';

        res
            .type('text/plain; charset=utf-8')
            .set('Cache-Control', 'no-store')
            .send(out);
    });

    app.listen(port, () => {
        console.log(
            `🌐 Web server en puerto ${port} (/health, /qr, /debug, /logs, /restart)`
        );
    });
};
