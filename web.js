// ======================================
// SERVIDOR WEB (health check + QR en navegador)
// ======================================

const express = require('express');
const qrcode = require('qrcode');

module.exports = function startWebServer(options) {

    const { getQr } = options;

    const app = express();

    const port =
        process.env.PORT || 7860;

    const token =
        process.env.QR_TOKEN || '';

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

    app.listen(port, () => {
        console.log(
            `🌐 Web server en puerto ${port} (/health, /qr)`
        );
    });
};
