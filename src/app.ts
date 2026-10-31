import {
  HubConnectionBuilder,
  HttpTransportType,
  LogLevel,
} from "@microsoft/signalr";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import express from "express";
import type { Request, Response } from "express";
import type { NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import dotenv from "dotenv";
import * as cbor from "cbor2";
import cors from "cors";
import axios from "axios";
import { createHash, randomUUID } from "node:crypto";
import { getF1TvSubscriptionToken } from "./f1tv-auth.js";
import { getF1ApiToken } from "./f1-api-auth.js";
import {
  SessionRecorder,
  type RecordingMetadata,
} from "./session-recorder.js";

// The mounted .env file is the source of truth for persisted tokens.
dotenv.config({ override: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`[Config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

function getTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

const ENV_FILE_PATH = path.resolve(process.cwd(), ".env");
const RECORDINGS_DIRECTORY = path.resolve(
  process.env.F1_RECORDINGS_DIR?.trim() || "recordings",
);
const MAX_RECORDING_UPLOAD_BYTES = 50 * 1024 * 1024;
const RECORDING_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,240}\.jsonl$/;

function isRecordingFilename(filename: string): boolean {
  return (
    filename === path.basename(filename) &&
    RECORDING_FILENAME_PATTERN.test(filename)
  );
}

/**
 * Persist configuration values in .env, replacing existing keys or appending
 * missing ones.
 */
function persistEnvVars(values: Record<string, string>): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_FILE_PATH, "utf-8");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  for (const [key, value] of Object.entries(values)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linePattern = new RegExp(`^${escapedKey}=.*$`, "m");
    const newLine = `${key}=${value}`;

    content = linePattern.test(content)
      ? content.replace(linePattern, newLine)
      : `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${newLine}\n`;
  }

  fs.writeFileSync(ENV_FILE_PATH, content, "utf-8");
}

type TokenStatus =
  | "not_configured"
  | "pending"
  | "authentication_in_progress"
  | "persisted_successfully"
  | "authentication_failed"
  | "refresh_failed_using_persisted_token"
  | "persistence_failed"
  | "manual_token_only";

interface TokenState {
  status: TokenStatus;
  lastUpdate: string | null;
}

function getInitialTokenState(
  token: string,
  configuredForAutomaticLogin: boolean,
  savedStatus: string | undefined,
  lastUpdate: string | undefined,
): TokenState {
  const validStatuses: TokenStatus[] = [
    "not_configured",
    "pending",
    "authentication_in_progress",
    "persisted_successfully",
    "authentication_failed",
    "refresh_failed_using_persisted_token",
    "persistence_failed",
    "manual_token_only",
  ];
  const status = validStatuses.find((item) => item === savedStatus);

  return {
    status: configuredForAutomaticLogin
      ? status ?? (token ? "persisted_successfully" : "pending")
      : token
        ? "manual_token_only"
        : "not_configured",
    lastUpdate: lastUpdate || null,
  };
}

function persistToken(
  tokenName: string,
  value: string,
  lastUpdateName: string,
  statusName: string,
  status: TokenStatus = "persisted_successfully",
): string {
  const lastUpdate = new Date().toISOString();
  persistEnvVars({
    [tokenName]: value,
    [lastUpdateName]: lastUpdate,
    [statusName]: status,
  });
  return lastUpdate;
}

function persistTokenStatus(name: string, status: TokenStatus): void {
  try {
    persistEnvVars({ [name]: status });
  } catch (error) {
    console.error(`[Config] Failed to persist ${name}:`, error);
  }
}

// Configuration
let F1TV_SUBSCRIPTION_TOKEN = (process.env.F1TVSUBSCRIPTION_TOKEN || "").trim();
let F1TV_TOKEN_SOURCE = F1TV_SUBSCRIPTION_TOKEN ? "environment" : "unset";
const F1TV_EMAIL = (process.env.F1TV_EMAIL || "").trim();
const F1TV_PASSWORD = process.env.F1TV_PASSWORD || "";
const F1TV_AUTH_MODE = (process.env.F1TV_AUTH_MODE || "automatic").trim().toLowerCase();
if (F1TV_AUTH_MODE !== "automatic" && F1TV_AUTH_MODE !== "manual") {
  console.error("[Config] F1TV_AUTH_MODE must be 'automatic' or 'manual'.");
  process.exit(1);
}
const F1TV_PLAYWRIGHT_EXECUTABLE_PATH = (
  process.env.F1TV_PLAYWRIGHT_EXECUTABLE_PATH || ""
).trim();
const hasF1TvCredentials = Boolean(F1TV_EMAIL && F1TV_PASSWORD);
const hasF1TvAuthSource =
  F1TV_AUTH_MODE === "automatic" && hasF1TvCredentials;
const F1TV_SHOW_BROWSER =
  process.platform === "win32" && process.env.F1TV_SHOW_BROWSER === "true";
if (process.env.F1TV_SHOW_BROWSER === "true" && process.platform !== "win32") {
  console.warn(
    "[F1] F1TV_SHOW_BROWSER is supported only when running locally on Windows; using headless Chromium.",
  );
}
if (F1TV_AUTH_MODE === "automatic" && Boolean(F1TV_EMAIL) !== Boolean(F1TV_PASSWORD)) {
  console.error("[Config] F1TV_EMAIL and F1TV_PASSWORD must both be configured.");
  process.exit(1);
}
if (F1TV_AUTH_MODE === "manual") {
  console.log("[F1] Manual token mode enabled; Playwright login is disabled.");
} else if (!hasF1TvCredentials) {
  console.warn(
    "[F1] Automatic login is not configured; use POST /api/config/f1tv-token to supply a token.",
  );
}
let NGROK_AUTHTOKEN = requireEnv("NGROK_AUTHTOKEN");
const NGROK_DOMAIN = requireEnv("NGROK_DOMAIN");
const NGROK_BIN = process.env.NGROK_BIN_PATH || "ngrok";
const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const BRIDGE_PORT = parseInt(requireEnv("BRIDGE_PORT"), 10);
const API_PORT = 3005;

// How long before a session's start we should reset the F1 connection, and
// how often to poll f1-api-ws for the time remaining. A fresh connection
// delivers a clean initial dump (no stale data from the previous session,
// e.g. drivers who retired), which is why we want it to land shortly before
// each session rather than relying on whatever the bridge picked up hours
// earlier (the bridge is often started the night before a race weekend).
const SESSION_RESET_LEAD_MINUTES = 15;
const SESSION_POLL_INTERVAL_MS = 10 * 60 * 1000;

// F1T_API_URL / F1T_API_TOKEN are optional: without them the bridge just
// skips notifying the API and relies on the API's own reconnect loop.
let F1T_API_URL = (process.env.F1T_API_URL || "").trim().replace(/\/$/, "");
let F1T_API_TOKEN = (process.env.F1T_API_TOKEN || "").trim();
const F1T_API_EMAIL = (process.env.F1T_API_EMAIL || "").trim();
const F1T_API_PASSWORD = process.env.F1T_API_PASSWORD || "";
if (Boolean(F1T_API_EMAIL) !== Boolean(F1T_API_PASSWORD)) {
  console.error(
    "[Config] F1T_API_EMAIL and F1T_API_PASSWORD must both be configured.",
  );
  process.exit(1);
}
if ((F1T_API_EMAIL || F1T_API_PASSWORD) && !F1T_API_URL) {
  console.error("[Config] F1T_API_URL is required for automatic API login.");
  process.exit(1);
}
const f1TvTokenState = getInitialTokenState(
  F1TV_SUBSCRIPTION_TOKEN,
  hasF1TvAuthSource,
  process.env.F1TVSUBSCRIPTION_TOKEN_STATUS,
  process.env.F1TVSUBSCRIPTION_TOKEN_LAST_UPDATE,
);
const telemetryTokenState = getInitialTokenState(
  F1T_API_TOKEN,
  Boolean(F1T_API_EMAIL && F1T_API_PASSWORD && F1T_API_URL),
  process.env.F1TELEMETRY_TOKEN_STATUS,
  process.env.F1TELEMETRY_TOKEN_LAST_UPDATE,
);

let f1Connection: any = null;
let isConnecting = false;
let isRefreshingF1Connection = false;
let wss: WebSocketServer | null = null;
let ngrokProcess: ChildProcess | null = null;
let lastSessionResetEventId: string | null = null;
let warnedMissingApiUrlForSessionCheck = false;
let f1TvAuthInitialized = false;
let f1TvManualOverride = false;
let f1TvRefreshTimer: NodeJS.Timeout | null = null;
let f1ApiAuthInitialized = false;
let f1ApiManualOverride = false;
let f1ApiRefreshTimer: NodeJS.Timeout | null = null;

interface FullState {
  R: any;
}

let fullState: FullState = {
  R: {},
};
const sessionRecorder = new SessionRecorder(
  process.env.F1_RECORDINGS_DIR?.trim(),
  uploadClosedRecording,
);

let httpServer: http.Server | null = null;
let apiServer: http.Server | null = null;

const app = express();
app.use(express.json());
app.use(cors());

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "F1 Bridge API",
      version: "1.0.0",
      description:
        "API HTTP del F1 Bridge, disponible en el puerto 3005. La lista completa de grabaciones no tiene paginación.",
    },
    servers: [{ url: "/", description: "Puerto HTTP 3005 del F1 Bridge" }],
    paths: {
      "/api/config/token-status": {
        get: {
          tags: ["Configuration"],
          summary: "Consulta estado y fecha de persistencia de los tokens",
          responses: {
            "200": {
              description: "Estado y fechas; no incluye los valores de tokens.",
            },
          },
        },
      },
      "/api/config/f1tv-token": {
        post: {
          tags: ["Configuration"],
          summary: "Guarda manualmente el token de suscripción de F1 TV y reinicia la conexión",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token"],
                  properties: {
                    token: {
                      type: "string",
                      description: "Token de suscripción de F1 TV. No se devuelve en la respuesta.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Token guardado y conexión con F1 restablecida." },
            "400": { description: "El token es obligatorio." },
            "500": { description: "No se pudo persistir el token." },
            "502": { description: "El token se guardó, pero no se pudo restablecer la conexión." },
          },
        },
      },
      "/api/config/telemetry-token": {
        post: {
          tags: ["Configuration"],
          summary: "Guarda manualmente el token de F1 Telemetry",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token"],
                  properties: {
                    token: {
                      type: "string",
                      description: "Token de F1 Telemetry. No se devuelve en la respuesta.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Token guardado; se notificó a la API para reconectar." },
            "400": { description: "El token es obligatorio." },
            "500": { description: "No se pudo persistir el token." },
          },
        },
      },
      "/api/recordings": {
        get: {
          tags: ["Recordings"],
          summary: "Lista todas las grabaciones locales, sin paginación",
          description:
            "Devuelve todas las sesiones locales. No requiere token; limita el acceso a una red de confianza.",
          responses: {
            "200": {
              description: "Lista completa, ordenada desde la grabación más reciente.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["success", "recordings"],
                    properties: {
                      success: { type: "boolean", example: true },
                      recordings: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["filename", "savedAt", "sizeBytes"],
                          properties: {
                            filename: {
                              type: "string",
                              example: "2026-77-race.jsonl",
                            },
                            savedAt: {
                              type: "string",
                              format: "date-time",
                              example: "2026-10-31T13:31:45.620Z",
                            },
                            sizeBytes: {
                              type: "integer",
                              example: 9158656,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/recordings/{filename}": {
        get: {
          tags: ["Recordings"],
          summary: "Descarga una grabación local",
          description:
            "No requiere token. Limita el acceso al bridge a una red de confianza.",
          parameters: [
            {
              name: "filename",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: RECORDING_FILENAME_PATTERN.source,
              },
            },
          ],
          responses: {
            "200": {
              description: "Archivo JSON Lines",
              content: {
                "application/x-ndjson": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
            "404": { description: "Archivo inexistente" },
          },
        },
        put: {
          tags: ["Recordings"],
          summary: "Sube una grabación JSON Lines al almacenamiento local",
          description:
            "No requiere token. Límite de 50 MB. No sobrescribe archivos existentes. Las sesiones grabadas automáticamente se suben a la API de F1 Telemetry al finalizar.",
          parameters: [
            {
              name: "filename",
              in: "path",
              required: true,
              schema: {
                type: "string",
                pattern: RECORDING_FILENAME_PATTERN.source,
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/x-ndjson": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: {
            "201": { description: "Grabación guardada localmente" },
            "400": { description: "Archivo vacío o nombre inválido" },
            "409": { description: "Ya existe una grabación con ese nombre" },
            "413": { description: "La grabación supera 50 MB" },
          },
        },
      },
    },
  },
  apis: [],
});

const parseRecordingUpload = express.raw({
  type: "application/x-ndjson",
  limit: MAX_RECORDING_UPLOAD_BYTES,
});

app.put(
  "/api/recordings/:filename",
  (req: Request, res: Response, next: NextFunction) => {
    parseRecordingUpload(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }

      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 400;
      if (status === 413) {
        res.status(413).json({
          success: false,
          error: "Recording exceeds the 50 MB upload limit.",
        });
        return;
      }

      next(error);
    });
  },
  async (req: Request, res: Response) => {
    const filename = req.params.filename;
    if (typeof filename !== "string" || !isRecordingFilename(filename)) {
      res.status(400).json({ success: false, error: "Invalid recording filename." });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ success: false, error: "Recording body is required." });
      return;
    }

    const filePath = path.join(RECORDINGS_DIRECTORY, filename);
    const temporaryPath = path.join(
      RECORDINGS_DIRECTORY,
      `.${filename}.${randomUUID()}.tmp`,
    );

    try {
      await fs.promises.mkdir(RECORDINGS_DIRECTORY, { recursive: true });
      await fs.promises.writeFile(temporaryPath, req.body, { flag: "wx" });
      await fs.promises.copyFile(
        temporaryPath,
        filePath,
        fs.constants.COPYFILE_EXCL,
      );
      await fs.promises.rm(temporaryPath, { force: true });
      const stats = await fs.promises.stat(filePath);
      res.status(201).json({
        success: true,
        filename,
        savedAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
      });
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch((cleanupError) => {
        console.error("[Recorder] Failed to remove temporary upload:", cleanupError);
      });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        res.status(409).json({
          success: false,
          error: "A recording with that filename already exists.",
        });
        return;
      }
      console.error(`[Recorder] Failed to save uploaded recording ${filename}:`, error);
      res.status(500).json({
        success: false,
        error: "Could not save uploaded recording.",
      });
    }
  },
);

app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "F1 Bridge API running",
    swagger: "/swagger",
    tokenStatus: "/api/config/token-status",
    setF1TvToken: "/api/config/f1tv-token",
    setTelemetryToken: "/api/config/telemetry-token",
    recordings: "/api/recordings",
  });
});

app.get(
  "/api/recordings",
  async (_req: Request, res: Response) => {
    try {
    await fs.promises.mkdir(RECORDINGS_DIRECTORY, { recursive: true });
    const entries = await fs.promises.readdir(RECORDINGS_DIRECTORY, {
        withFileTypes: true,
      });
      const recordings = await Promise.all(
        entries
          .filter(
            (entry) => entry.isFile() && isRecordingFilename(entry.name),
          )
          .map(async (entry) => {
            const stats = await fs.promises.stat(
              path.join(RECORDINGS_DIRECTORY, entry.name),
            );
            return {
              filename: entry.name,
              savedAt: stats.mtime.toISOString(),
              sizeBytes: stats.size,
            };
          }),
      );

      recordings.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
      res.json({ success: true, recordings });
    } catch (error) {
      console.error("[Recorder] Failed to list recordings:", error);
      res.status(500).json({
        success: false,
        error: "Could not list recordings.",
      });
    }
  },
);

app.get(
  "/api/recordings/:filename",
  (req: Request, res: Response) => {
    const filename = req.params.filename;
    if (typeof filename !== "string" || !isRecordingFilename(filename)) {
      res.status(404).json({ success: false, error: "Recording not found." });
      return;
    }

    res.download(
      path.join(RECORDINGS_DIRECTORY, filename),
      filename,
      (error) => {
        if (!error) return;
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          res.status(404).json({ success: false, error: "Recording not found." });
          return;
        }
        console.error(`[Recorder] Failed to download ${filename}:`, error);
        res.status(500).json({
          success: false,
          error: "Could not download recording.",
        });
      },
    );
  },
);

app.get("/api/config/token-status", (_req: Request, res: Response) => {
  res.json({
    F1TVSUBSCRIPTION_TOKEN: { ...f1TvTokenState },
    F1TELEMETRY_TOKEN: { ...telemetryTokenState },
  });
});

app.post("/api/config/telemetry-token", async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "El campo token es obligatorio." });
    return;
  }

  let lastUpdate: string;
  try {
    lastUpdate = persistToken(
      "F1T_API_TOKEN",
      token,
      "F1TELEMETRY_TOKEN_LAST_UPDATE",
      "F1TELEMETRY_TOKEN_STATUS",
      "manual_token_only",
    );
  } catch (error) {
    console.error("[F1 API] Failed to persist manually supplied token:", error);
    res.status(500).json({ error: "No se pudo guardar el token de F1 Telemetry." });
    return;
  }

  F1T_API_TOKEN = token;
  f1ApiManualOverride = true;
  telemetryTokenState.lastUpdate = lastUpdate;
  telemetryTokenState.status = "manual_token_only";
  if (f1ApiRefreshTimer) {
    clearTimeout(f1ApiRefreshTimer);
    f1ApiRefreshTimer = null;
  }

  await notifyApiToReconnect();
  res.json({
    message: "Token de F1 Telemetry guardado.",
    status: telemetryTokenState.status,
    lastUpdate,
  });
});

app.post("/api/config/f1tv-token", async (req: Request, res: Response) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "El campo token es obligatorio." });
    return;
  }

  let lastUpdate: string;
  try {
    lastUpdate = persistToken(
      "F1TVSUBSCRIPTION_TOKEN",
      token,
      "F1TVSUBSCRIPTION_TOKEN_LAST_UPDATE",
      "F1TVSUBSCRIPTION_TOKEN_STATUS",
      "manual_token_only",
    );
  } catch (error) {
    console.error("[F1] Failed to persist manually supplied subscription token:", error);
    res.status(500).json({ error: "No se pudo guardar el token de F1 TV." });
    return;
  }

  F1TV_SUBSCRIPTION_TOKEN = token;
  f1TvManualOverride = true;
  F1TV_TOKEN_SOURCE = "manual-api";
  f1TvTokenState.lastUpdate = lastUpdate;
  f1TvTokenState.status = "manual_token_only";
  if (f1TvRefreshTimer) {
    clearTimeout(f1TvRefreshTimer);
    f1TvRefreshTimer = null;
  }

  try {
    if (f1Connection) {
      await refreshF1Connection();
    } else {
      await initBridge();
      if (!f1Connection) {
        throw new Error("F1 connection was not established.");
      }
    }

    res.json({
      message: "Token guardado y conexión con F1 restablecida.",
      status: f1TvTokenState.status,
      lastUpdate,
    });
  } catch (error) {
    console.error(
      "[F1] Manual token was saved, but the F1 connection could not be restored:",
      error instanceof Error ? error.name : "Unknown error",
    );
    res.status(502).json({
      error: "El token se guardó, pero no se pudo restablecer la conexión con F1.",
      tokenSaved: true,
      status: f1TvTokenState.status,
      lastUpdate,
    });
  }
});

async function uploadClosedRecording(
  filePath: string,
  metadata: RecordingMetadata,
): Promise<void> {
  if (process.env.F1T_RECORDINGS_AUTO_UPLOAD === "false") {
    console.log("[Recorder] Automatic upload disabled; recording remains local.");
    return;
  }
  if (!F1T_API_URL || !F1T_API_TOKEN) {
    console.warn(
      "[Recorder] Recording remains local; configure the F1 Telemetry API admin token to upload it.",
    );
    return;
  }

  const filename = path.basename(filePath);
  if (!isRecordingFilename(filename)) {
    throw new Error("Recording filename is not valid for upload.");
  }

  const stats = await fs.promises.stat(filePath);
  if (stats.size > MAX_RECORDING_UPLOAD_BYTES) {
    throw new Error(
      `Recording is ${stats.size} bytes; the API upload limit is ${MAX_RECORDING_UPLOAD_BYTES} bytes.`,
    );
  }

  const sessionId = filename.slice(0, -".jsonl".length);
  const uploadUrl = `${F1T_API_URL}/admin/recordings/${encodeURIComponent(sessionId)}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.put(uploadUrl, fs.createReadStream(filePath), {
        params: {
          sessionName: metadata.sessionName ?? undefined,
          sessionType: metadata.sessionType ?? undefined,
        },
        headers: {
          Authorization: `Bearer ${F1T_API_TOKEN}`,
          "Content-Type": "application/x-ndjson",
          "Content-Length": stats.size,
        },
        maxBodyLength: MAX_RECORDING_UPLOAD_BYTES,
        timeout: 120_000,
      });
      console.log(`[Recorder] Uploaded recording to API: ${filename}`);
      return;
    } catch (error) {
      lastError = error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const isRetryable = status === undefined || status === 429 || status >= 500;
      if (!isRetryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }

  console.error(`[Recorder] Could not upload ${filename}; local copy retained:`, lastError);
}

async function refreshF1Connection(): Promise<void> {
  // Suppresses the old connection's onclose handler from scheduling its
  // own reconnect below, since stop() triggers that same close event.
  isRefreshingF1Connection = true;
  try {
    if (f1Connection) {
      try {
        await f1Connection.stop();
      } catch (err) {
        console.warn("[Bridge] Error stopping old F1 connection:", err);
      }
      f1Connection = null;
    }

    await connectToF1();
  } finally {
    isRefreshingF1Connection = false;
  }
}

function getJwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function scheduleF1TvTokenRefresh(token: string): void {
  if (f1TvRefreshTimer) clearTimeout(f1TvRefreshTimer);

  if (!F1TV_EMAIL || !F1TV_PASSWORD) return;

  const expiry = getJwtExpiry(token) ?? Date.now() + 24 * 60 * 60 * 1000;
  const refreshDelay = Math.max(60000, expiry - Date.now() - 5 * 60 * 1000);
  f1TvRefreshTimer = setTimeout(async () => {
    try {
      await refreshF1TvSubscriptionToken();
    } catch (error) {
      console.error("[F1] Automatic token refresh failed:", error);
      scheduleF1TvTokenRetry();
    }
  }, refreshDelay);
  f1TvRefreshTimer.unref();
}

function scheduleF1ApiTokenRefresh(token: string): void {
  if (f1ApiRefreshTimer) clearTimeout(f1ApiRefreshTimer);
  if (!F1T_API_EMAIL || !F1T_API_PASSWORD) return;

  const expiry = getJwtExpiry(token) ?? Date.now() + 24 * 60 * 60 * 1000;

  f1ApiRefreshTimer = setTimeout(async () => {
    try {
      await refreshF1ApiToken(true);
    } catch (error) {
      console.error("[F1 API] Automatic token refresh failed:", error);
      scheduleF1ApiTokenRetry();
    }
  }, Math.max(60000, expiry - Date.now() - 5 * 60 * 1000));
  f1ApiRefreshTimer.unref();
}

function scheduleF1ApiTokenRetry(): void {
  f1ApiRefreshTimer = setTimeout(async () => {
    try {
      await refreshF1ApiToken(true);
    } catch (error) {
      console.error("[F1 API] Automatic token refresh retry failed:", error);
      scheduleF1ApiTokenRetry();
    }
  }, 5 * 60 * 1000);
  f1ApiRefreshTimer.unref();
}

async function refreshF1ApiToken(notifyApi = false): Promise<void> {
  telemetryTokenState.status = "authentication_in_progress";
  let persistenceFailed = false;
  try {
    const token = await getF1ApiToken({
      baseUrl: F1T_API_URL,
      email: F1T_API_EMAIL,
      password: F1T_API_PASSWORD,
    });

    try {
      telemetryTokenState.lastUpdate = persistToken(
        "F1T_API_TOKEN",
        token,
        "F1TELEMETRY_TOKEN_LAST_UPDATE",
        "F1TELEMETRY_TOKEN_STATUS",
      );
    } catch (error) {
      persistenceFailed = true;
      telemetryTokenState.status = "persistence_failed";
      persistTokenStatus("F1TELEMETRY_TOKEN_STATUS", telemetryTokenState.status);
      throw error;
    }

    F1T_API_TOKEN = token;
    telemetryTokenState.status = "persisted_successfully";
    scheduleF1ApiTokenRefresh(token);
    console.log("[F1 API] Login token refreshed and saved.");

    if (notifyApi) await notifyApiToReconnect();
  } catch (error) {
    if (!persistenceFailed) {
      telemetryTokenState.status = F1T_API_TOKEN
        ? "refresh_failed_using_persisted_token"
        : "authentication_failed";
      persistTokenStatus("F1TELEMETRY_TOKEN_STATUS", telemetryTokenState.status);
    }
    throw error;
  }
}

async function initializeF1ApiAuth(): Promise<void> {
  if (
    f1ApiManualOverride ||
    f1ApiAuthInitialized ||
    !F1T_API_EMAIL ||
    !F1T_API_PASSWORD
  ) {
    return;
  }

  try {
    await refreshF1ApiToken();
  } catch (error) {
    if (F1T_API_TOKEN) {
      console.error(
        "[F1 API] Automatic login failed; continuing with the existing F1T_API_TOKEN:",
        error,
      );
    } else {
      console.error("[F1 API] Automatic login failed; will retry in five minutes:", error);
    }
    scheduleF1ApiTokenRetry();
  }

  f1ApiAuthInitialized = true;
}

function scheduleF1TvTokenRetry(): void {
  f1TvRefreshTimer = setTimeout(async () => {
    try {
      await refreshF1TvSubscriptionToken();
    } catch (error) {
      console.error("[F1] Automatic token refresh retry failed:", error);
      scheduleF1TvTokenRetry();
    }
  }, 5 * 60 * 1000);
  f1TvRefreshTimer.unref();
}

async function refreshF1TvSubscriptionToken(): Promise<void> {
  f1TvTokenState.status = "authentication_in_progress";
  let token: string;
  let tokenSource: string;
  let persistenceFailed = false;
  try {
    const tokenResult = await getF1TvSubscriptionToken({
      email: F1TV_EMAIL,
      password: F1TV_PASSWORD,
      ...(F1TV_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: F1TV_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
      headless: !F1TV_SHOW_BROWSER,
    });
    token = tokenResult.token;
    tokenSource = tokenResult.source;
    console.log(
      `[F1] Playwright selected token fingerprint=${getTokenFingerprint(token)} length=${token.length} source=${tokenSource || "unknown"}.`,
    );

    try {
      f1TvTokenState.lastUpdate = persistToken(
        "F1TVSUBSCRIPTION_TOKEN",
        token,
        "F1TVSUBSCRIPTION_TOKEN_LAST_UPDATE",
        "F1TVSUBSCRIPTION_TOKEN_STATUS",
      );
    } catch (error) {
      persistenceFailed = true;
      f1TvTokenState.status = "persistence_failed";
      persistTokenStatus(
        "F1TVSUBSCRIPTION_TOKEN_STATUS",
        f1TvTokenState.status,
      );
      throw error;
    }
  } catch (error) {
    if (!persistenceFailed) {
      f1TvTokenState.status = F1TV_SUBSCRIPTION_TOKEN
        ? "refresh_failed_using_persisted_token"
        : "authentication_failed";
      persistTokenStatus(
        "F1TVSUBSCRIPTION_TOKEN_STATUS",
        f1TvTokenState.status,
      );
    }
    throw error;
  }

  F1TV_SUBSCRIPTION_TOKEN = token;
  F1TV_TOKEN_SOURCE = `playwright:${tokenSource}`;
  f1TvTokenState.status = "persisted_successfully";
  scheduleF1TvTokenRefresh(token);

  if (f1Connection) await refreshF1Connection();
  console.log("[F1] F1 TV subscription token refreshed and saved.");
}

async function initializeF1TvAuth(): Promise<void> {
  if (F1TV_AUTH_MODE === "manual" || f1TvManualOverride) return;
  if (f1TvAuthInitialized || !hasF1TvAuthSource) return;

  try {
    await refreshF1TvSubscriptionToken();
  } catch (error) {
    if (!F1TV_SUBSCRIPTION_TOKEN) throw error;

    f1TvTokenState.status = "refresh_failed_using_persisted_token";
    persistTokenStatus("F1TVSUBSCRIPTION_TOKEN_STATUS", f1TvTokenState.status);
    console.error(
      "[F1] Automatic login failed; continuing with the existing F1TVSUBSCRIPTION_TOKEN:",
      error,
    );
    scheduleF1TvTokenRefresh(F1TV_SUBSCRIPTION_TOKEN);
    scheduleF1TvTokenRetry();
  }
  f1TvAuthInitialized = true;
}

/**
 * Tell f1-api-ws to reset its reconnect counter and retry connecting to
 * this bridge, so we don't have to trigger it by hand via Swagger every
 * time the bridge (re)starts. Best-effort: f1-api-ws has its own backoff
 * reconnect loop as a fallback if this fails or isn't configured.
 */
async function notifyApiToReconnect(): Promise<void> {
  if (!F1T_API_URL || !F1T_API_TOKEN) {
    console.log(
      "[Bridge] F1T_API_URL/F1T_API_TOKEN not set, skipping API reconnect notification.",
    );
    return;
  }

  try {
    await axios.post(
      `${F1T_API_URL}/admin/bridge/reset-reconnect`,
      {},
      {
        headers: { Authorization: `Bearer ${F1T_API_TOKEN}` },
        timeout: 10000,
      },
    );
    console.log("[Bridge] Notified f1-api-ws to reset/reconnect to bridge.");
  } catch (err: any) {
    console.warn(
      "[Bridge] Failed to notify f1-api-ws to reconnect:",
      err?.response?.data ?? err.message,
    );
  }
}

/**
 * Poll f1-api-ws for how long until the next session and, once we're
 * within SESSION_RESET_LEAD_MINUTES of it, reset the F1 connection so the
 * fresh SignalR handshake delivers a clean initial dump right before the
 * session starts (instead of carrying over stale state from whatever the
 * bridge picked up earlier, e.g. overnight). Only resets once per session,
 * tracked by the upcoming event's id, since /upcoming keeps returning the
 * same event with a shrinking countdown until it actually starts.
 */
async function checkUpcomingSessionAndReset(): Promise<void> {
  if (!F1T_API_URL) {
    if (!warnedMissingApiUrlForSessionCheck) {
      console.log(
        "[Bridge] F1T_API_URL not set, skipping pre-session connection reset.",
      );
      warnedMissingApiUrlForSessionCheck = true;
    }
    return;
  }

  try {
    const { data } = await axios.get(`${F1T_API_URL}/upcoming`, {
      timeout: 10000,
    });

    const nextEvent = data?.nextEvent;
    const totalMinutes = data?.timeUntilNext?.totalMinutes;
    if (!nextEvent || typeof totalMinutes !== "number") return;

    if (
      totalMinutes <= SESSION_RESET_LEAD_MINUTES &&
      lastSessionResetEventId !== nextEvent.id
    ) {
      console.log(
        `[Bridge] Session "${nextEvent.type}" at ${nextEvent.track} starts in ${totalMinutes}m, resetting F1 connection for a fresh dump.`,
      );
      lastSessionResetEventId = nextEvent.id;
      await refreshF1Connection();
    }
  } catch (err: any) {
    console.warn(
      "[Bridge] Failed to check upcoming session for pre-session reset:",
      err?.response?.data ?? err.message,
    );
  }
}

/**
 * Connect to F1 via SignalR
 */
async function connectToF1(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      console.log(
        `[F1] Creating SignalR connection with token fingerprint=${getTokenFingerprint(F1TV_SUBSCRIPTION_TOKEN)} length=${F1TV_SUBSCRIPTION_TOKEN.length} source=${F1TV_TOKEN_SOURCE}.`,
      );

      const connection = new HubConnectionBuilder()
        .withUrl("https://livetiming.formula1.com/signalrcore", {
          transport: HttpTransportType.WebSockets,
          accessTokenFactory: () => F1TV_SUBSCRIPTION_TOKEN,
          headers: {
            "User-Agent": "BestHTTP",
            "Accept-Encoding": "gzip,identity",
          },
        })
        .configureLogging(LogLevel.Information)
        .build();

      f1Connection = connection;

      connection.on(
        "feed",
        (feedName: string, data: any, timestamp: string) => {
          console.log(
            `[F1] Received feed: ${feedName}`,
            JSON.stringify(data).substring(0, 100),
          );

          // Los datos ya vienen decodificados (JSON objects), no CBOR
          processFeed(feedName, data);
          sessionRecorder.recordFeed(feedName, data, timestamp, fullState);

          // Codifica a CBOR para enviar a los clientes WebSocket
          const messageToClients = {
            M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
          };
          broadcastToClients(encodeCBOR(messageToClients));
        },
      );

      connection.onclose((error: any) => {
        // Ignore close events from a connection that's already been
        // superseded by a newer one (e.g. a late-firing close racing
        // with a reconnect that already succeeded).
        if (f1Connection !== connection) {
          console.log("[F1] Stale SignalR connection closed, ignoring.");
          return;
        }

        console.log("[F1] SignalR connection closed:", error);
        f1Connection = null;

        if (isRefreshingF1Connection) {
          // refreshF1Connection() called stop() deliberately and is about
          // to reconnect itself; don't schedule a duplicate reconnect.
          return;
        }

        setTimeout(() => {
          initBridge().catch((err) =>
            console.error("[F1] Reconnection failed:", err.message),
          );
        }, 5000);
      });

      connection
        .start()
        .then(() => {
          console.log("[F1] SignalR connected successfully");

          // Subscribe to feeds
          connection
            .invoke("Subscribe", [
              "Heartbeat",
              "CarData",
              "Position",
              "ExtrapolatedClock",
              "TopThree",
              "TimingStats",
              "TimingAppData",
              "WeatherData",
              "TrackStatus",
              "DriverList",
              "RaceControlMessages",
              "SessionInfo",
              "SessionData",
              "LapCount",
              "TimingData",
              "TyreStintSeries",
              "TeamRadio",
              "CarData.z",
              "Position.z",
            ])
            .then((subscriptionData: any) => {
              if (subscriptionData) {
                console.log(
                  "[F1] Received initial subscription data with keys:",
                  Object.keys(subscriptionData),
                );
                fullState.R = subscriptionData;
                sessionRecorder.recordInitialState(fullState);
                // Envía el dump inicial codificado a CBOR, con la misma forma
                // (sin el wrapper "R") que reciben los clientes nuevos al conectarse.
                broadcastToClients(encodeCBOR(fullState.R));
              }
              resolve();
            })
            .catch((err: any) => {
              console.error("[F1] Subscribe failed:", err);
              reject(err);
            });
        })
        .catch((err: any) => {
          console.error("[F1] SignalR connection failed:", err);
          reject(err);
        });
    } catch (err) {
      console.error("[F1] Error creating connection:", err);
      reject(err);
    }
  });
}

/**
 * Broadcast data to all connected WebSocket clients
 */
function broadcastToClients(data: Buffer) {
  if (!wss) return;

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      try {
        client.send(data);
      } catch (err) {
        console.error("[Bridge] Error sending to client:", err);
      }
    }
  });
}

/**
 * Start the WebSocket server on port 5631
 */
function startWebSocketServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      httpServer = http.createServer();
      wss = new WebSocketServer({ server: httpServer });

      wss.on("connection", (ws) => {
        console.log(
          "[WSS] New client connected. Total clients:",
          wss!.clients.size,
        );

        // Send initial state to client
        if (fullState.R) {
          try {
            const stateBuffer = encodeCBOR(fullState.R
            );
            ws.send(stateBuffer);
            console.log("[WSS] Sent initial state to new client");
          } catch (err) {
            console.error("[WSS] Error sending initial state:", err);
          }
        }

        ws.on("close", () => {
          console.log(
            "[WSS] Client disconnected. Total clients:",
            wss!.clients.size,
          );
        });

        ws.on("error", (err) => {
          console.error("[WSS] Client error:", err.message);
        });
      });

      httpServer.listen(BRIDGE_PORT, "0.0.0.0", () => {
        console.log(
          `[WSS] WebSocket server listening on ws://0.0.0.0:${BRIDGE_PORT}`,
        );
        resolve();
      });

      httpServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.error(`[WSS] Port ${BRIDGE_PORT} is already in use`);
        } else {
          console.error("[WSS] Server error:", err);
        }
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll ngrok's local web inspection API until the tunnel is reported active.
 */
async function waitForNgrokUrl(retries = 20, delayMs = 500): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { data } = await axios.get(NGROK_API_URL);
      const tunnel = data?.tunnels?.find((t: any) => t.proto === "https");
      if (tunnel?.public_url) {
        return tunnel.public_url;
      }
    } catch {
      // ngrok's local API isn't up yet, keep retrying
    }
    await sleep(delayMs);
  }
  throw new Error("Timed out waiting for ngrok tunnel to become active.");
}

/**
 * Launch the ngrok CLI as a child process so the tunnel is reachable
 * publicly. Using the CLI binary (instead of the @ngrok/ngrok native
 * npm SDK) keeps this working on environments like Termux, where
 * native napi bindings are not reliably supported.
 */
async function startNgrokTunnel(): Promise<void> {
  ngrokProcess = spawn(
    NGROK_BIN,
    ["http", String(BRIDGE_PORT), `--url=https://${NGROK_DOMAIN}`],
    {
      env: { ...process.env, NGROK_AUTHTOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  ngrokProcess.stdout?.on("data", (chunk) =>
    console.log(`[Ngrok] ${chunk.toString().trim()}`),
  );
  ngrokProcess.stderr?.on("data", (chunk) =>
    console.error(`[Ngrok] ${chunk.toString().trim()}`),
  );

  ngrokProcess.on("error", (err: any) => {
    if (err.code === "ENOENT") {
      console.error(
        `[Ngrok] Could not find the "${NGROK_BIN}" binary. Install ngrok and make sure it's on PATH, or set NGROK_BIN_PATH.`,
      );
    } else {
      console.error("[Ngrok] Failed to start process:", err);
    }
  });

  ngrokProcess.on("exit", (code, signal) => {
    console.warn(`[Ngrok] Process exited (code=${code}, signal=${signal}).`);
    ngrokProcess = null;
  });

  const publicUrl = await waitForNgrokUrl();
  console.log(`[Ngrok] Tunnel established at: ${publicUrl}`);
}

/**
 * Initialize the bridge
 */
async function initBridge(): Promise<void> {
  if (isConnecting) {
    console.log("[Bridge] Already attempting to connect...");
    return;
  }

  isConnecting = true;

  try {
    await initializeF1ApiAuth();
    await initializeF1TvAuth();

    // Step 1: Start WebSocket server
    if (!wss) {
      await startWebSocketServer();
    }

    // Step 2: Open the ngrok tunnel
    if (!ngrokProcess) {
      await startNgrokTunnel();
    }

    // Step 3: Connect to F1 TV via SignalR
    if (!f1Connection || f1Connection.state !== 1) {
      // ConnectionState.Connected = 1
      await connectToF1();
    }

    console.log("[Bridge] Bridge fully initialized.");
    await notifyApiToReconnect();
  } catch (error) {
    console.error("[Bridge] Initialization failed:", error);
    isConnecting = false;
    setTimeout(
      initBridge,
      hasF1TvAuthSource && !F1TV_SUBSCRIPTION_TOKEN ? 300000 : 10000,
    );
  }

  isConnecting = false;
}

/**
 * Graceful shutdown
 */
function shutdown(): void {
  console.log("[Bridge] Shutting down gracefully...");

  try {
    if (f1Connection) {
      f1Connection.stop();
    }
  } catch {}

  try {
    if (ngrokProcess) {
      ngrokProcess.kill();
    }
  } catch {}

  try {
    if (wss) {
      wss.close();
    }
  } catch {}

  try {
    if (httpServer) {
      httpServer.close();
    }
  } catch {}

  try {
    if (apiServer) {
      apiServer.close();
    }
  } catch {}

  process.exit(0);
}

// Start the bridge
initBridge().catch((err) => {
  console.error("[Bridge] Fatal error:", err);
  process.exit(1);
});

console.log("[Bridge] F1 TV Broadcast Bridge starting...");

apiServer = app.listen(API_PORT, "0.0.0.0", () => {
  console.log(`[API] HTTP server listening on http://0.0.0.0:${API_PORT}`);
});

apiServer?.on("error", (err: any) => {
  console.error("[API] Server error:", err);
});

checkUpcomingSessionAndReset();
setInterval(checkUpcomingSessionAndReset, SESSION_POLL_INTERVAL_MS);

// Helper functions
function encodeCBOR(data: any): Buffer {
  return Buffer.from(cbor.encode(data));
}

function deepMerge(target: any, source: any) {
  for (const key in source) {
    if (Array.isArray(source[key])) {
      target[key] = source[key];
    } else if (source[key] instanceof Object && source[key] !== null) {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

function processFeed(feedName: string, data: any) {
  if (!fullState.R) {
    fullState.R = {};
  }

  switch (feedName) {
    case "Heartbeat":
      if (!fullState.R.Heartbeat) fullState.R.Heartbeat = {};
      deepMerge(fullState.R.Heartbeat, data);
      break;
    case "CarData.z":
      if (!fullState.R.CarData) fullState.R.CarData = {};
      deepMerge(fullState.R.CarData, data);
      break;
    case "Position.z":
      if (!fullState.R.Position) fullState.R.Position = {};
      deepMerge(fullState.R.Position, data);
      break;
    case "TimingData":
      if (!fullState.R.TimingData) fullState.R.TimingData = {};
      deepMerge(fullState.R.TimingData, data);
      break;
    case "TimingStats":
      if (!fullState.R.TimingStats) fullState.R.TimingStats = {};
      deepMerge(fullState.R.TimingStats, data);
      break;
    case "TimingAppData":
      if (!fullState.R.TimingAppData) fullState.R.TimingAppData = {};
      deepMerge(fullState.R.TimingAppData, data);
      break;
    case "WeatherData":
      if (!fullState.R.WeatherData) fullState.R.WeatherData = {};
      deepMerge(fullState.R.WeatherData, data);
      break;
    case "TrackStatus":
      if (!fullState.R.TrackStatus) fullState.R.TrackStatus = {};
      deepMerge(fullState.R.TrackStatus, data);
      break;
    case "DriverList":
      if (!fullState.R.DriverList) fullState.R.DriverList = {};
      deepMerge(fullState.R.DriverList, data);
      break;
    case "RaceControlMessages":
      if (!fullState.R.RaceControlMessages)
        fullState.R.RaceControlMessages = {};
      deepMerge(fullState.R.RaceControlMessages, data);
      break;
    case "SessionInfo":
      if (!fullState.R.SessionInfo) fullState.R.SessionInfo = {};
      deepMerge(fullState.R.SessionInfo, data);
      break;
    case "SessionData":
      if (!fullState.R.SessionData) fullState.R.SessionData = {};
      deepMerge(fullState.R.SessionData, data);
      break;
    case "ExtrapolatedClock":
      if (!fullState.R.ExtrapolatedClock) fullState.R.ExtrapolatedClock = {};
      deepMerge(fullState.R.ExtrapolatedClock, data);
      break;
    case "TyreStintSeries":
      if (!fullState.R.TyreStintSeries) fullState.R.TyreStintSeries = {};
      deepMerge(fullState.R.TyreStintSeries, data);
      break;
    case "TeamRadio":
      if (!fullState.R.TeamRadio) fullState.R.TeamRadio = {};
      deepMerge(fullState.R.TeamRadio, data);
      break;
    case "TopThree":
      if (!fullState.R.TopThree) fullState.R.TopThree = {};
      deepMerge(fullState.R.TopThree, data);
      break;
    case "LapCount":
      if (!fullState.R.LapCount) fullState.R.LapCount = {};
      deepMerge(fullState.R.LapCount, data);
      break;
    default:
      console.warn(`[Bridge] Feed "${feedName}" not recognized.`);
  }
}
