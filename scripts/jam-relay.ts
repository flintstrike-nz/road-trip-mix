// Local jam relay: serves the static joiner page and shuttles WebSocket
// frames between joiner devices and the host. It never looks inside a message.
//
//   joiners  -> ws://<lan-ip>:PORT/ws       (open to anyone on the network; the
//                                           host enforces the join code)
//   host     -> ws://localhost:PORT/host    (loopback only, Origin-checked)
//
// The Android app embeds an equivalent relay natively (JamRelayPlugin); this
// one is for running the host from a browser, e.g. on a laptop, and for tests.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { HostToRelay, RelayToHost } from "../lib/jam/protocol";
import { MAX_FRAME_BYTES } from "../lib/jam/protocol";

export type RelayOptions = {
  port?: number;
  webRoot?: string;
  hostOrigins?: string[]; // browser origins allowed to act as host
  maxClients?: number;
  maxMsgsPerSec?: number;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out.length ? out : [`http://localhost:${port}`];
}

const isLoopback = (addr?: string) => !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

export async function startRelay(opts: RelayOptions = {}) {
  const webRoot = path.resolve(opts.webRoot ?? path.join(__dirname, "..", "jam-client", "dist"));
  const hostOrigins = opts.hostOrigins ?? (process.env.JAM_HOST_ORIGINS?.split(",") ?? ["http://localhost:3000"]);
  const maxClients = opts.maxClients ?? 32;
  const maxMsgsPerSec = opts.maxMsgsPerSec ?? 30;

  let host: WebSocket | null = null;
  const clients = new Map<string, WebSocket>();

  const toHost = (msg: RelayToHost) => {
    if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify(msg));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(webRoot, rel);
    // Refuse anything that resolves outside the web root (../ and symlink-free absolute tricks).
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      }).end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES * 2 });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/host") {
      const origin = req.headers.origin;
      const allowed = isLoopback(req.socket.remoteAddress) && (!origin || hostOrigins.includes(origin));
      if (!allowed) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attachHost(ws));
    } else if (pathname === "/ws") {
      if (!host || clients.size >= maxClients) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws));
    } else {
      socket.destroy();
    }
  });

  function attachHost(ws: WebSocket) {
    host?.close(1000, "replaced");
    host = ws;
    ws.on("message", (raw: RawData) => {
      let msg: HostToRelay;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "send") {
        const c = clients.get(msg.clientId);
        if (c?.readyState === WebSocket.OPEN) c.send(msg.data);
      } else if (msg.type === "broadcast") {
        clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg.data));
      } else if (msg.type === "close") {
        clients.get(msg.clientId)?.close(4000, "removed");
      }
    });
    ws.on("close", () => {
      if (host !== ws) return;
      host = null;
      // No host, no session: drop the joiners so they show "host went away".
      clients.forEach((c) => c.close(1001, "host gone"));
    });
    const port = (server.address() as { port: number }).port;
    toHost({ type: "ready", port, urls: lanUrls(port) });
  }

  function attachClient(ws: WebSocket) {
    const clientId = randomUUID();
    clients.set(clientId, ws);
    toHost({ type: "connected", clientId });

    let tokens = maxMsgsPerSec;
    const refill = setInterval(() => (tokens = maxMsgsPerSec), 1000);
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 15000);

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return;
      if (tokens-- <= 0) return; // drop floods instead of forwarding them to the host
      const data = raw.toString();
      if (data.length > MAX_FRAME_BYTES) return;
      toHost({ type: "message", clientId, data });
    });
    ws.on("close", () => {
      clearInterval(refill);
      clearInterval(ping);
      clients.delete(clientId);
      toHost({ type: "disconnected", clientId });
    });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    urls: lanUrls(port),
    async close() {
      host?.terminate();
      clients.forEach((c) => c.terminate());
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.JAM_PORT ?? 8787);
  startRelay({ port }).then((r) => {
    console.log(`Jam relay listening on port ${r.port}`);
    r.urls.forEach((u) => console.log(`  joiners open: ${u}`));
    console.log("Host connects at ws://localhost:" + r.port + "/host");
  });
}
