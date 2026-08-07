#!/bin/sh
set -e

# Limpiar locks/ports del perfil de Chrome reutilizado
rm -f .wwebjs_auth/session/Singleton* .wwebjs_auth/session/DevToolsActivePort

exec dumb-init node bot.js
