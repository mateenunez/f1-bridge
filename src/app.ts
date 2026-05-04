import WebSocket from "ws";
import net from "net";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Configuration
const F1TV_SUBSCRIPTION_TOKEN = process.env.F1TVSUBSCRIPTION_TOKEN || '';
const DROPLET_PORT = parseInt(process.env.DROPLET_PORT || '9000');
const DROPLET_HOST = '127.0.0.1'; // Localhost because we use SSH tunnel

let dropletSocket: net.Socket | null = null;
let f1Connection: WebSocket | null = null;
let isConnecting = false;

/**
 * Connect to the Droplet (via SSH Tunnel)
 */
function connectToDroplet(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[Droplet] Attempting to connect to port ${DROPLET_PORT}...`);

    dropletSocket = new net.Socket();

    dropletSocket.connect(DROPLET_PORT, DROPLET_HOST, () => {
      console.log('[Droplet] Connection established successfully.');
      resolve();
    });

    dropletSocket.on('error', (err) => {
      console.error('[Droplet] Connection error:', err.message);
      dropletSocket = null;
      reject(err);
    });

    dropletSocket.on('close', () => {
      console.log('[Droplet] Connection closed. Attempting to reconnect in 5s...');
      dropletSocket = null;
      setTimeout(() => {
        connectToDroplet().catch((err) =>
          console.error('[Droplet] Reconnection failed:', err.message)
        );
      }, 5000);
    });

    dropletSocket.on('drain', () => {
      console.log('[Droplet] Buffer drained, ready for more data.');
    });

    // Set a timeout for connection attempt
    setTimeout(() => {
      if (dropletSocket && !dropletSocket.readyState) {
        dropletSocket.destroy();
        reject(new Error('Connection timeout'));
      }
    }, 5000);
  });
}

/**
 * Negotiate with F1 TV API
 */
async function negotiateF1TV(): Promise<string[]> {
  try {
    const hub = encodeURIComponent(JSON.stringify([{ name: 'Streaming' }]));
    const url = `https://livetiming.formula1.com/signalrcore/negotiate?connectionData=${hub}&clientProtocol=1.5`;
    const headers = {
      Authorization: `Bearer ${F1TV_SUBSCRIPTION_TOKEN}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      Origin: 'https://account.formula1.com',
      Referer: 'https://account.formula1.com/',
      'Content-Type': 'application/json',
    };

    console.log('[F1] Negotiating with F1TV API...');
    const response = await axios.post(url, null, { headers });

    if (response.status === 200) {
      const cookies = response.headers['set-cookie'] || [];
      console.log('[F1] Negotiation successful. Cookies obtained:', cookies.length);
      return cookies;
    }

    throw new Error(`Unexpected response status: ${response.status}`);
  } catch (error) {
    const e = error as any;
    console.error(
      '[F1] Error during negotiation:',
      e.response?.data || e.message
    );
    throw error;
  }
}

/**
 * Connect to F1 WebSocket with SignalR
 */
async function connectToF1TV(
  subscriptionToken: string,
  cookies: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const cookieString = (cookies || [])
        .map((cookie: string) => cookie.split(";")[0]!.trim())
        .join('; ');

      console.log('[F1] Connecting to F1TV WebSocket...');

      const ws = new WebSocket('https://livetiming.formula1.com/signalrcore', {
        headers: {
          Cookie: cookieString,
          'User-Agent': 'BestHTTP',
          'Accept-Encoding': 'gzip,identity',
        },
      });

      f1Connection = ws;

      ws.on('open', () => {
        console.log('[F1] Connected to F1TV WebSocket.');
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        // Send F1 data to Droplet via TCP
        if (dropletSocket && dropletSocket.writable) {
          try {
            // Send the raw data
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
            dropletSocket.write(buffer);
          } catch (err) {
            console.error('[Bridge] Error sending data to Droplet:', err);
          }
        } else {
          console.warn('[Bridge] Droplet socket not ready, data dropped.');
        }
      });

      ws.on('error', (err) => {
        console.error('[F1] WebSocket error:', err.message);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        console.log(
          '[F1] WebSocket closed. Code:',
          code,
          'Reason:',
          reason?.toString?.() || reason
        );
        f1Connection = null;
        // Attempt to reconnect
        setTimeout(() => {
          initBridge().catch((err) =>
            console.error('[F1] Reconnection failed:', err.message)
          );
        }, 5000);
      });
    } catch (err) {
      console.error('[F1] Error connecting to WebSocket:', err);
      reject(err);
    }
  });
}

/**
 * Initialize the bridge (connect to Droplet first, then to F1)
 */
async function initBridge(): Promise<void> {
  if (isConnecting) {
    console.log('[Bridge] Already attempting to connect...');
    return;
  }

  isConnecting = true;

  try {
    // Step 1: Ensure Droplet connection
    if (!dropletSocket || !dropletSocket.writable) {
      await connectToDroplet();
    }

    // Step 2: If F1 is not connected, connect
    if (!f1Connection || f1Connection.readyState !== WebSocket.OPEN) {
      // Negotiate with F1
      const cookies = await negotiateF1TV();

      // Connect to F1 WebSocket
      await connectToF1TV(F1TV_SUBSCRIPTION_TOKEN, cookies);
    }

    console.log('[Bridge] Bridge fully initialized.');
  } catch (error) {
    console.error('[Bridge] Initialization failed:', error);
    isConnecting = false;
    // Retry after 10 seconds
    setTimeout(initBridge, 10000);
  }

  isConnecting = false;
}

/**
 * Graceful shutdown
 */
function shutdown(): void {
  console.log('[Bridge] Shutting down gracefully...');

  try {
    if (f1Connection) {
      f1Connection.close();
    }
  } catch {}

  try {
    if (dropletSocket) {
      dropletSocket.destroy();
    }
  } catch {}

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the bridge
initBridge().catch((err) => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});

console.log('[Bridge] F1 TV Message Bridge started.');
