import type { HostToRelay, RelayToHost } from "./protocol";

// How the host engine talks to joiner devices. The relay on the other end is
// deliberately dumb (it only moves text frames), so the same engine runs behind
// either the native Android relay or the Node relay.

export type HotspotInfo = { ssid: string; password: string };

export type TransportInfo = {
  port: number;
  urls: string[]; // base URLs joiners can open, e.g. http://192.168.43.1:8787
  hotspot?: HotspotInfo | null;
  // Set when a hotspot was requested but Android couldn't start one.
  hotspotError?: string;
};

export type TransportEvent = Exclude<RelayToHost, { type: "ready" }>;

export interface HostTransport {
  start(): Promise<TransportInfo>;
  stop(): Promise<void>;
  send(clientId: string, data: string): void;
  broadcast(data: string): void;
  close(clientId: string): void;
  onEvent(cb: (e: TransportEvent) => void): () => void;
}

// Host side of the Node relay (scripts/jam-relay.ts), reached over a loopback
// WebSocket. Used when the host is a browser rather than the Android app.
export class WebSocketHostTransport implements HostTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: TransportEvent) => void>();

  constructor(private url = "ws://localhost:8787/host", private WS: typeof WebSocket = WebSocket) {}

  start(): Promise<TransportInfo> {
    return new Promise((resolve, reject) => {
      const ws = new this.WS(this.url);
      this.ws = ws;
      ws.onerror = () => reject(new Error(`Can't reach the jam relay at ${this.url}. Is "npm run jam-relay" running?`));
      ws.onmessage = (ev) => {
        let msg: RelayToHost;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "ready") resolve({ port: msg.port, urls: msg.urls });
        else this.listeners.forEach((l) => l(msg));
      };
      ws.onclose = () => reject(new Error("Jam relay closed the connection."));
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  private write(msg: HostToRelay) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  send(clientId: string, data: string) {
    this.write({ type: "send", clientId, data });
  }
  broadcast(data: string) {
    this.write({ type: "broadcast", data });
  }
  close(clientId: string) {
    this.write({ type: "close", clientId });
  }
  onEvent(cb: (e: TransportEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
