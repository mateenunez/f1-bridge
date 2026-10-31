[![en](https://img.shields.io/badge/lang-en-blue.svg)](https://github.com/mateenunez/f1-bridge/blob/master/README.en.md)
[![es](https://img.shields.io/badge/lang-es-yellow.svg)](https://github.com/mateenunez/f1-bridge/blob/master/README.md)
# F1 Bridge

Este repositorio contiene el backend del puente F1 Bridge que conecta a los clientes WebSocket con los feeds de Formula 1 a través de la API de F1 TV.

## Qué hace el Bridge

- Conecta a `https://livetiming.formula1.com/signalrcore` usando SignalR.
- Recibe feeds en tiempo real como `CarData`, `Position`, `TimingData`, `WeatherData`, `RaceControlMessages`, etc.
- Mantiene un estado completo en memoria (`fullState.R`) para enviar a nuevos clientes WebSocket.
- Expone un servidor WebSocket en el puerto `5631` para que otros clientes puedan consumir los datos.
- Abre su propio túnel de ngrok apuntando a ese puerto (lanzando el binario `ngrok` como subproceso), así que no hace falta correr un contenedor ni un proceso de ngrok aparte: `docker compose up` (o `npm start`) deja el bridge y el túnel arriba juntos.
- Expone un servidor HTTP en el puerto `3005` para ver Swagger en `/swagger` y el estado de los tokens en `/api/config/token-status`. Este endpoint nunca devuelve los valores secretos.

- Al terminar de inicializarse, llama a `POST {F1T_API_URL}/admin/bridge/reset-reconnect` para que la API se reconecte automáticamente al bridge.
- Graba las sesiones automáticamente cuando `SessionStatus` pasa a `Started` y cierra el archivo cuando pasa a `Finalised`. Qualifying se divide en archivos Q1/Q2/Q3 al cambiar `SessionData.Series`.
- Las grabaciones son JSON Lines (`.jsonl`), compatibles con el formato que consume el replay actual; se guardan en `recordings/` (persistente en Docker).
- Si el bridge se reinicia mientras la sesión sigue en `Started`, continúa agregando datos al archivo existente de esa sesión (incluyendo la parte actual de Qualifying). El tiempo durante el reinicio no se recupera.
- Al cerrarse cada archivo, lo sube automáticamente a F1 Telemetry usando las credenciales de administrador de la API configuradas en el bridge.

## Endpoints principales

- `GET /` - Responde con un mensaje básico de estado.
- `GET /swagger` - Documentación Swagger de la API.
- `GET /api/config/token-status` - Indica estado y última fecha de persistencia de cada token; nunca expone los JWT.
- `POST /api/config/f1tv-token` - Guarda un token de F1 TV ingresado manualmente, lo persiste en `.env` y reinicia la conexión SignalR. Recibe JSON con `{"token":"..."}`; el token nunca se devuelve en la respuesta.
- `POST /api/config/telemetry-token` - Guarda un token de F1 Telemetry, lo persiste en `.env` y notifica a la API para que reconecte. Recibe JSON con `{"token":"..."}`; el token nunca se devuelve en la respuesta.
- `GET /api/recordings` - Lista las grabaciones locales con nombre, fecha de guardado y tamaño.
- `GET /api/recordings/:filename` - Descarga una grabación local.
- `PUT /api/recordings/:filename` - Sube una grabación `.jsonl` al almacenamiento local (máximo 50 MB; no sobrescribe nombres existentes).

## Variables de entorno actuales (`.env`)

`BRIDGE_PORT`, `NGROK_AUTHTOKEN` y `NGROK_DOMAIN` son necesarias para iniciar el bridge y el túnel. Las credenciales de F1 TV son opcionales si vas a ingresar el token manualmente desde Swagger; sin token ni credenciales, el bridge inicia pero no recibe feeds hasta que se configure un token.

```dotenv
BRIDGE_PORT=
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
F1TV_EMAIL=
F1TV_PASSWORD=
F1TV_AUTH_MODE=automatic
# Se puede dejar vacío y cargar manualmente desde POST /api/config/f1tv-token.
F1TVSUBSCRIPTION_TOKEN=
F1T_API_URL=https://api.f1telemetry.com
F1T_API_EMAIL=
F1T_API_PASSWORD=
F1T_API_TOKEN=
```

- `NGROK_AUTHTOKEN`: token de tu cuenta de ngrok.
- `NGROK_DOMAIN`: dominio fijo de ngrok (sin esquema, ej. `tu-dominio.ngrok-free.dev`) al que se conectan los clientes por `wss://`.
- `F1TV_EMAIL` y `F1TV_PASSWORD`: credenciales opcionales de tu cuenta F1. Si se configuran, Playwright inicia sesión al arrancar, valida el token contra Live Timing, lo guarda junto con la fecha en `.env` y lo renueva antes de su expiración (o cada 24 h si el JWT no incluye `exp`).
- `F1TV_AUTH_MODE`: `automatic` (default) usa Playwright y requiere las credenciales anteriores para renovar automáticamente; `manual` desactiva Playwright y usa el token guardado o el endpoint manual. En Termux/Android configurá `F1TV_AUTH_MODE=manual`.
- `F1TVSUBSCRIPTION_TOKEN`: administrado automáticamente. Si ya hay uno, se usa como fallback ante una falla temporal de login.

Opcional (no requerida, tiene default):

- `NGROK_BIN_PATH`: ruta al ejecutable `ngrok` si no está en el `PATH`. Por defecto usa `ngrok`.
- `F1TV_SHOW_BROWSER`: `false` por defecto. Solo en Windows local, ponelo en `true` para ver la ventana de Chromium durante el login. En Docker y otros sistemas se ignora y Chromium se mantiene headless.
- `F1TV_PLAYWRIGHT_EXECUTABLE_PATH`: ruta a un Chromium/Chrome instalado manualmente.

