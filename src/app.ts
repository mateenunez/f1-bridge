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
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import dotenv from "dotenv";
import * as cbor from "cbor2";
import cors from "cors";
import axios from "axios";

// override: true ensures the mounted .env file (which the update-token
// endpoint rewrites) always wins over a stale value baked into the
// container's env at creation time.
dotenv.config({ override: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`[Config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

const ENV_FILE_PATH = path.resolve(process.cwd(), ".env");

/**
 * Persist a key=value pair into the .env file, replacing the existing
 * line for that key if present, or appending it otherwise.
 */
function persistEnvVar(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(ENV_FILE_PATH, "utf-8");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linePattern = new RegExp(`^${escapedKey}=.*$`, "m");
  const newLine = `${key}=${value}`;

  const updated = linePattern.test(content)
    ? content.replace(linePattern, newLine)
    : `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}${newLine}\n`;

  fs.writeFileSync(ENV_FILE_PATH, updated, "utf-8");
}

// Configuration
let F1TV_SUBSCRIPTION_TOKEN = requireEnv("F1TVSUBSCRIPTION_TOKEN");
let NGROK_AUTHTOKEN = requireEnv("NGROK_AUTHTOKEN");
const NGROK_DOMAIN = requireEnv("NGROK_DOMAIN");
const NGROK_BIN = process.env.NGROK_BIN_PATH || "ngrok";
const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const BRIDGE_PORT = parseInt(requireEnv("BRIDGE_PORT"), 10);
const API_PORT = 3005;

// F1T_API_URL / F1T_API_TOKEN are optional: without them the bridge just
// skips notifying the API and relies on the API's own reconnect loop.
let F1T_API_URL = (process.env.F1T_API_URL || "").trim().replace(/\/$/, "");
let F1T_API_TOKEN = (process.env.F1T_API_TOKEN || "").trim();

let f1Connection: any = null;
let isConnecting = false;
let isRefreshingF1Connection = false;
let wss: WebSocketServer | null = null;
let ngrokProcess: ChildProcess | null = null;

interface FullState {
  R: any;
}

let fullState: FullState = {
  R: {},
};

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
        "API para actualizar el token de F1 y ver documentación Swagger en local.",
    },
    servers: [{ url: "/" }],
    paths: {
      "/api/config/update-token": {
        post: {
          tags: ["Configuration"],
          summary:
            "Actualiza el token de suscripción F1TV y lo persiste en .env",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    F1TVSUBSCRIPTION_TOKEN: {
                      type: "string",
                      description: "Nuevo token de suscripción F1TV",
                    },
                  },
                  required: ["F1TVSUBSCRIPTION_TOKEN"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Token actualizado en memoria y guardado en .env para el próximo arranque.",
            },
            "400": {
              description: "Solicitud inválida.",
            },
            "500": {
              description: "Error interno al actualizar los tokens.",
            },
          },
        },
      },
      "/api/config/update-api-token": {
        post: {
          tags: ["Configuration"],
          summary:
            "Actualiza el token admin de f1-api-ws (JWT), lo persiste en .env, y reintenta de inmediato notificarle que reintente la conexión al bridge",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    F1T_API_TOKEN: {
                      type: "string",
                      description:
                        "JWT de un usuario admin de f1-api-ws (expira a los 7 días, se obtiene vía POST /users/login)",
                    },
                  },
                  required: ["F1T_API_TOKEN"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Token actualizado en memoria y guardado en .env; se reintentó notificar a f1-api-ws con el token nuevo.",
            },
            "400": {
              description: "Solicitud inválida.",
            },
            "500": {
              description: "Error interno al actualizar el token.",
            },
          },
        },
      },
    },
  },
  apis: [],
});

app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "F1 Bridge API running",
    swagger: "/swagger",
  });
});

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

app.post(
  "/api/config/update-token",
  async (req: Request, res: Response): Promise<Response> => {
    const { F1TVSUBSCRIPTION_TOKEN: newToken } = req.body;
    if (typeof newToken !== "string" || newToken.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "F1TVSUBSCRIPTION_TOKEN is required.",
      });
    }
    F1TV_SUBSCRIPTION_TOKEN = newToken.trim();

    try {
      persistEnvVar("F1TVSUBSCRIPTION_TOKEN", F1TV_SUBSCRIPTION_TOKEN);
    } catch (err) {
      console.error("[API] Failed to persist token to .env:", err);
      return res.status(500).json({
        success: false,
        message: "Token updated in memory but failed to persist to .env.",
        error: String(err),
      });
    }

    try {
      await refreshF1Connection();
    } catch (err) {
      console.error("[API] Token update failed:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to refresh F1 connection.",
        error: String(err),
      });
    }
    console.log(
      "[API] F1TVSUBSCRIPTION_TOKEN updated via API and persisted to .env.",
    );
    return res.json({
      success: true,
      message:
        "F1TV_SUBSCRIPTION_TOKEN actualizado y guardado en .env correctamente.",
    });
  },
);

app.post(
  "/api/config/update-api-token",
  async (req: Request, res: Response): Promise<Response> => {
    const { F1T_API_TOKEN: newToken } = req.body;
    if (typeof newToken !== "string" || newToken.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "F1T_API_TOKEN is required.",
      });
    }
    F1T_API_TOKEN = newToken.trim();

    try {
      persistEnvVar("F1T_API_TOKEN", F1T_API_TOKEN);
    } catch (err) {
      console.error("[API] Failed to persist API token to .env:", err);
      return res.status(500).json({
        success: false,
        message: "Token updated in memory but failed to persist to .env.",
        error: String(err),
      });
    }

    console.log("[API] F1T_API_TOKEN updated via API and persisted to .env.");

    // Retry immediately with the new token instead of waiting for the next
    // bridge restart, mirroring how update-token refreshes the F1 connection.
    await notifyApiToReconnect();

    return res.json({
      success: true,
      message: "F1T_API_TOKEN actualizado y guardado en .env correctamente.",
    });
  },
);

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
 * Connect to F1 via SignalR
 */
async function connectToF1(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      console.log("[F1] Creating SignalR connection...");

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
    setTimeout(initBridge, 10000);
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
