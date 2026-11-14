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
- Los nombres usan el año, el nombre del Grand Prix, la sesión y la parte de Qualifying cuando corresponde; por ejemplo: `2026-mexico-city-grand-prix-qualifying-q1.jsonl`.
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

Swagger está disponible en `http://localhost:3005/swagger`. Desde allí puedes listar todas las grabaciones sin paginación, descargar archivos y subir grabaciones. Los endpoints de grabaciones locales no requieren el token de administrador de F1 Telemetry. Restringe el acceso al puerto `3005` a una red de confianza y no lo expongas a Internet. El `F1T_API_TOKEN` configurado en el bridge se usa únicamente para solicitudes salientes a F1 Telemetry, como la subida automática de grabaciones. F1 Telemetry guarda las grabaciones subidas en PostgreSQL junto con `sessionName` y `sessionType`, obtenidos de `SessionInfo`; la lista completa y la descarga por `sessionId` están disponibles mediante `GET /api/admin/recordings` y `GET /api/admin/recordings/:sessionId`.

## Variables de entorno actuales (`.env`)

`BRIDGE_PORT`, `NGROK_AUTHTOKEN` y `NGROK_DOMAIN` son necesarias para iniciar el bridge y el túnel. Las credenciales de F1 TV son opcionales si vas a ingresar el token manualmente desde Swagger; sin token ni credenciales, el bridge inicia pero no recibe feeds hasta que se configure un token.

```dotenv
BRIDGE_PORT=5631
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

Para automatizar completamente la integración con F1 Telemetry, configura lo siguiente:

- `F1T_API_URL`: URL base de la API, sin `/` al final; para producción usa `https://api.f1telemetry.com`.
- `F1T_API_EMAIL` y `F1T_API_PASSWORD`: credenciales de una cuenta administradora de F1 Telemetry. El bridge envía `POST {F1T_API_URL}/users/login`, extrae `token` de `{ success, user, token }` y lo guarda como `F1T_API_TOKEN` junto con la fecha. Programa su renovación antes del vencimiento (o cada 24 horas si el JWT no tiene el claim `exp`).
- `F1T_API_TOKEN`: se administra automáticamente y se conserva como alternativa ante fallas temporales de login. No es necesario para listar ni descargar grabaciones locales.
- `F1T_RECORDINGS_AUTO_UPLOAD`: sube cada archivo cuando se cierra si está habilitado (por defecto, `true`). Ponlo en `false` para conservar las grabaciones solo localmente. La API acepta archivos de hasta 50 MB, por lo que admite grabaciones de 8 MB.
- Las subidas fallidas se reintentan hasta tres veces y se conserva la copia local. Si la subida sigue fallando, descarga el archivo mediante `GET /api/recordings`.
- Si no configuras credenciales de la API, puedes establecer o actualizar el token mediante `POST /api/config/telemetry-token`; el bridge lo persiste y solicita a la API que se reconecte.
- `F1TVSUBSCRIPTION_TOKEN_LAST_UPDATE` y `F1TELEMETRY_TOKEN_LAST_UPDATE`: fechas ISO 8601 que se actualizan cuando se persiste el token correspondiente.
- `F1TVSUBSCRIPTION_TOKEN_STATUS` y `F1TELEMETRY_TOKEN_STATUS`: estado del último intento de autenticación o persistencia.

En el endpoint de estado, `F1TELEMETRY_TOKEN` se refiere al token guardado como `F1T_API_TOKEN`. Si el token ya estaba configurado antes de que se agregaran las variables `*_LAST_UPDATE`, su fecha seguirá siendo `null` hasta el próximo login automático exitoso y su persistencia.

Docker monta `./.env` dentro del contenedor, por lo que los tokens, estados y fechas persisten en el host. En el primer inicio, completa `.env` con las variables de ngrok y, si quieres autenticación automática, las credenciales de F1 TV y F1 Telemetry. También puedes configurar el token de F1 TV desde Swagger después de iniciar el bridge.

El endpoint `GET /api/config/token-status` devuelve los estados (`pending`, `authentication_in_progress`, `persisted_successfully`, `authentication_failed`, `refresh_failed_using_persisted_token`, `persistence_failed`, `manual_token_only` o `not_configured`) y fechas ISO 8601. Por seguridad, nunca incluye el contenido de los tokens.

Los logs de autenticación de F1 TV muestran el origen del token, su longitud, una huella SHA-256 abreviada y el estado HTTP de su validación contra SignalR. No imprimen el JWT completo. La huella permite verificar que Playwright y la conexión SignalR usan el mismo token sin exponer la credencial.

Los endpoints `POST /api/config/f1tv-token` y `POST /api/config/telemetry-token`, también disponibles en Swagger, aceptan el token correspondiente en el cuerpo JSON (`{"token":"..."}`). Lo guardan en `.env` con el estado `manual_token_only`; el endpoint de F1 TV reinicia la conexión SignalR y el de Telemetry notifica a la API para que se reconecte. Las respuestas incluyen solo el estado y la fecha de actualización, nunca el token. Usa estos endpoints en una red de confianza y no expongas públicamente el puerto HTTP `3005`.

## Grabación automática de sesiones

La grabación se ejecuta dentro del proceso del bridge y lee los mismos feeds que recibe de F1 TV; no se necesita ningún endpoint adicional para iniciarla. Comienza al recibir `SessionStatus: Started` y se cierra al recibir `SessionStatus: Finalised`. En Qualifying, los cambios de `QualifyingPart` en `Series` crean archivos separados para Q1, Q2 y Q3. Las sesiones de práctica y carrera crean un archivo por sesión.
