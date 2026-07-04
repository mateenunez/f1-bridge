import {
  HubConnectionBuilder,
  HttpTransportType,
  LogLevel,
} from "@microsoft/signalr";
import { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import type { Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import dotenv from "dotenv";
import * as cbor from "cbor2";

dotenv.config();

// Configuration
let F1TV_SUBSCRIPTION_TOKEN = process.env.F1TVSUBSCRIPTION_TOKEN || "";
let NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || "";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "5631");
const API_PORT = 3000;

let f1Connection: any = null;
let isConnecting = false;
let wss: WebSocketServer | null = null;

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

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "F1 Bridge API",
      version: "1.0.0",
      description:
        "API para actualizar el token de F1 y ver documentación Swagger en local.",
    },
    servers: [
      {
        url: "http://0.0.0.0:3000",
      },
    ],
    paths: {
      "/api/config/update-token": {
        post: {
          tags: ["Configuration"],
          summary:
            "Actualiza el token de suscripción F1TV y el token/link de ngrok",
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
                "Token y ngrok actualizados correctamente para el fin de semana.",
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
  if (f1Connection) {
    try {
      await f1Connection.stop();
    } catch (err) {
      console.warn("[Bridge] Error stopping old F1 connection:", err);
    }
    f1Connection = null;
  }

  await connectToF1();
}

app.post(
  "/api/config/update-token",
  async (req: Request, res: Response): Promise<Response> => {
    const {
      F1TVSUBSCRIPTION_TOKEN: newToken,
      NGROK_AUTHTOKEN: newNgrokToken,
    } = req.body;

    if (
      typeof newToken !== "string" ||
      newToken.trim().length === 0 ||
      typeof newNgrokToken !== "string" ||
      newNgrokToken.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "F1TVSUBSCRIPTION_TOKEN and NGROK_AUTHTOKEN are required strings.",
      });
    }

    F1TV_SUBSCRIPTION_TOKEN = newToken.trim();
    NGROK_AUTHTOKEN = newNgrokToken.trim();

    try {
      await refreshF1Connection();
    } catch (err) {
      console.error("[API] Token update failed:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to refresh F1 connection after updating tokens.",
        error: String(err),
      });
    }

    console.log(
      "[API] F1TVSUBSCRIPTION_TOKEN and NGROK_AUTHTOKEN updated via API.",
    );

    return res.json({
      success: true,
      message:
        "Token y link de ngrok actualizados correctamente para este fin de semana de carrera.",
    });
  },
);

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
        console.log("[F1] SignalR connection closed:", error);
        f1Connection = null;
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
                // Envía el dump inicial codificado a CBOR
                broadcastToClients(encodeCBOR(fullState));
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

    // Step 2: Connect to F1 TV via SignalR
    if (!f1Connection || f1Connection.state !== 1) {
      // ConnectionState.Connected = 1
      await connectToF1();
    }

    console.log("[Bridge] Bridge fully initialized.");
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
