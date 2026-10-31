[![en](https://img.shields.io/badge/lang-en-blue.svg)](https://github.com/mateenunez/f1-bridge/blob/master/README.en.md)
[![es](https://img.shields.io/badge/lang-es-yellow.svg)](https://github.com/mateenunez/f1-bridge/blob/master/README.md)
# F1 Bridge

This repository contains the backend for F1 Bridge, which connects WebSocket clients to Formula 1 feeds through the F1 TV API.

## What the Bridge Does

- Connects to `https://livetiming.formula1.com/signalrcore` using SignalR.
- Receives real-time feeds such as `CarData`, `Position`, `TimingData`, `WeatherData`, `RaceControlMessages`, and others.
- Keeps the complete state in memory (`fullState.R`) and sends it to new WebSocket clients.
- Exposes a WebSocket server on port `5631` for clients to consume the data.
- Starts its own ngrok tunnel pointing to that port by launching the `ngrok` binary as a child process. No separate container or ngrok process is required: `docker compose up` (or `npm start`) starts both the bridge and the tunnel.
- Exposes an HTTP server on port `3005` for Swagger at `/swagger` and token status at `/api/config/token-status`. The status endpoint never returns secret values.
- Calls `POST {F1T_API_URL}/admin/bridge/reset-reconnect` after initialization so the API reconnects to the bridge automatically.
- Automatically records sessions when `SessionStatus` changes to `Started` and closes the file when it changes to `Finalised`. Qualifying is split into Q1/Q2/Q3 files when `SessionData.Series` changes.
- Saves recordings as JSON Lines (`.jsonl`), compatible with the current replay format, in `recordings/` (persisted in Docker).
- If the bridge restarts while the session is still `Started`, it resumes appending to the existing file for that session, including the current Qualifying part. The time during the restart cannot be recovered.
- Uploads each file to F1 Telemetry when it closes, using the API administrator credentials configured in the bridge.

## Main Endpoints

- `GET /` - Returns a basic status message.
- `GET /swagger` - Swagger documentation for the API.
- `GET /api/config/token-status` - Returns the status and last persistence date for each token; JWT values are never exposed.
- `POST /api/config/f1tv-token` - Saves an F1 TV token entered manually, persists it in `.env`, and restarts the SignalR connection. Accepts JSON such as `{"token":"..."}`; the token is never returned.
- `POST /api/config/telemetry-token` - Saves an F1 Telemetry token, persists it in `.env`, and notifies the API to reconnect. Accepts JSON such as `{"token":"..."}`; the token is never returned.
- `GET /api/recordings` - Lists local recordings with their filename, save date, and size.
- `GET /api/recordings/:filename` - Downloads a local recording.
- `PUT /api/recordings/:filename` - Uploads a `.jsonl` recording to local storage (up to 50 MB; existing filenames are not overwritten).

Swagger is available at `http://localhost:3005/swagger`. From there, you can list all recordings without pagination, download files, and upload recordings. Local recording endpoints do not require the F1 Telemetry administrator token. Restrict access to port `3005` to a trusted network and do not expose it to the public Internet. The `F1T_API_TOKEN` configured in the bridge is used only for outgoing requests to F1 Telemetry, such as automatic recording uploads. F1 Telemetry stores uploaded recordings in PostgreSQL along with `sessionName` and `sessionType` obtained from `SessionInfo`; its complete list and download by `sessionId` are available through `GET /api/admin/recordings` and `GET /api/admin/recordings/:sessionId`.

## Environment Variables (`.env`)

`BRIDGE_PORT`, `NGROK_AUTHTOKEN`, and `NGROK_DOMAIN` are required to start the bridge and tunnel. F1 TV credentials are optional if you enter the token manually through Swagger. Without a token or credentials, the bridge starts but will not receive feeds until a token is configured.

```dotenv
BRIDGE_PORT=5631
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
F1TV_EMAIL=
F1TV_PASSWORD=
F1TV_AUTH_MODE=automatic
# Leave empty to set manually through POST /api/config/f1tv-token.
F1TVSUBSCRIPTION_TOKEN=
F1T_API_URL=https://api.f1telemetry.com
F1T_API_EMAIL=
F1T_API_PASSWORD=
F1T_API_TOKEN=
```

- `NGROK_AUTHTOKEN`: your ngrok account token.
- `NGROK_DOMAIN`: the fixed ngrok domain (without a scheme, e.g. `your-domain.ngrok-free.dev`) used by clients over `wss://`.
- `F1TV_EMAIL` and `F1TV_PASSWORD`: optional F1 account credentials. When configured, Playwright signs in on startup, validates the token against Live Timing, saves it with its date in `.env`, and renews it before it expires (or every 24 hours if the JWT has no `exp` claim).
- `F1TV_AUTH_MODE`: `automatic` (default) uses Playwright and requires the credentials above for automatic renewal; `manual` disables Playwright and uses the saved token or the manual endpoint. On Termux/Android, set `F1TV_AUTH_MODE=manual`.
- `F1TVSUBSCRIPTION_TOKEN`: managed automatically. If already set, it is used as a fallback during temporary login failures.

Optional settings (defaults are provided):

- `NGROK_BIN_PATH`: path to the `ngrok` executable if it is not in `PATH`. Defaults to `ngrok`.
- `F1TV_SHOW_BROWSER`: defaults to `false`. Set to `true` only for local Windows use to show the Chromium window during login. It is ignored in Docker and other systems, where Chromium remains headless.
- `F1TV_PLAYWRIGHT_EXECUTABLE_PATH`: path to a manually installed Chromium/Chrome executable.

To fully automate integration with F1 Telemetry, configure the following:

- `F1T_API_URL`: API base URL without a trailing `/`; use `https://api.f1telemetry.com` for production.
- `F1T_API_EMAIL` and `F1T_API_PASSWORD`: credentials for an F1 Telemetry administrator account. The bridge sends `POST {F1T_API_URL}/users/login`, extracts `token` from `{ success, user, token }`, and saves it as `F1T_API_TOKEN` along with the date. It schedules renewal before expiration (or every 24 hours if the JWT has no `exp` claim).
- `F1T_API_TOKEN`: managed automatically and retained as a fallback during temporary login failures. It is not required to list or download local recordings.
- `F1T_RECORDINGS_AUTO_UPLOAD`: uploads each file when it closes if enabled (default: `true`). Set to `false` to keep recordings local only. The API accepts files up to 50 MB, so recordings of 8 MB are supported.
- Failed uploads are retried up to three times, and the local copy is retained. If the upload still fails, download it through `GET /api/recordings`.
- If API credentials are not configured, you can set or update the token using `POST /api/config/telemetry-token`; the bridge persists it and requests that the API reconnect.
- `F1TVSUBSCRIPTION_TOKEN_LAST_UPDATE` and `F1TELEMETRY_TOKEN_LAST_UPDATE`: ISO 8601 dates updated whenever the corresponding token is persisted.
- `F1TVSUBSCRIPTION_TOKEN_STATUS` and `F1TELEMETRY_TOKEN_STATUS`: status of the latest authentication or persistence attempt.

In the status endpoint, `F1TELEMETRY_TOKEN` refers to the token stored as `F1T_API_TOKEN`. If the token was already present before the `*_LAST_UPDATE` variables were introduced, its date will remain `null` until the next successful automatic login and persistence.

Docker mounts `./.env` inside the container, so tokens, statuses, and dates persist on the host. On first startup, fill in `.env` with the ngrok variables and, if you want automatic authentication, the F1 TV and F1 Telemetry credentials. You can also set the F1 TV token in Swagger after starting the bridge.

The `GET /api/config/token-status` endpoint returns statuses (`pending`, `authentication_in_progress`, `persisted_successfully`, `authentication_failed`, `refresh_failed_using_persisted_token`, `persistence_failed`, `manual_token_only`, or `not_configured`) and ISO 8601 dates. For security, it never includes token contents.

F1 TV authentication logs show the token source, its length, a shortened SHA-256 fingerprint, and the HTTP status from validation against SignalR. They do not print the full JWT. The fingerprint lets you verify that Playwright and the SignalR connection use the same token without exposing the credential.

The `POST /api/config/f1tv-token` and `POST /api/config/telemetry-token` endpoints, also available in Swagger, accept the corresponding token in the JSON body (`{"token":"..."}`). They save it in `.env` with the `manual_token_only` status; the F1 TV endpoint restarts the SignalR connection, while the Telemetry endpoint notifies the API to reconnect. Responses include only the status and update date, never the token. Use these endpoints on a trusted network and do not expose HTTP port `3005` publicly.

## Automatic Session Recording

Recording runs inside the bridge process and reads the same feeds received from F1 TV; no additional endpoint is needed to start it. A recording starts when `SessionStatus: Started` is received and closes when `SessionStatus: Finalised` is received. In Qualifying, changes to `QualifyingPart` in `Series` create separate files for Q1, Q2, and Q3. Practice and race sessions create one file per session.
