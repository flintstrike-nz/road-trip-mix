import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { HostTransport, HotspotInfo, TransportEvent, TransportInfo } from "./transport";

// Bridges to the Android app's native plugins (see android/.../plugins).
// All of this is inert in a normal browser: `isNativeApp()` is false and the
// plugin proxies are never called.

export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

export type JamRelayPlugin = {
  start(opts: { port?: number; hotspot?: boolean }): Promise<TransportInfo>;
  stop(): Promise<void>;
  send(opts: { clientId: string; data: string }): Promise<void>;
  broadcast(opts: { data: string }): Promise<void>;
  close(opts: { clientId: string }): Promise<void>;
  addListener(event: "relayEvent", cb: (e: TransportEvent) => void): Promise<PluginListenerHandle>;
};

export type PlayerStateEvent = {
  paused: boolean;
  positionMs: number;
  trackUri: string | null;
};

export type SpotifyRemotePlugin = {
  connect(opts: { clientId: string; redirectUri: string }): Promise<void>;
  disconnect(): Promise<void>;
  play(opts: { uri: string }): Promise<void>;
  queue(opts: { uri: string }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  skipNext(): Promise<void>;
  getPlayerState(): Promise<PlayerStateEvent>;
  addListener(event: "playerState", cb: (e: PlayerStateEvent) => void): Promise<PluginListenerHandle>;
};

export const JamRelay = registerPlugin<JamRelayPlugin>("JamRelay");
export const SpotifyRemote = registerPlugin<SpotifyRemotePlugin>("SpotifyRemote");

export class CapacitorHostTransport implements HostTransport {
  private listeners = new Set<(e: TransportEvent) => void>();
  private handle: PluginListenerHandle | null = null;

  constructor(private opts: { hotspot: boolean; port?: number }) {}

  async start(): Promise<TransportInfo> {
    this.handle = await JamRelay.addListener("relayEvent", (e) => this.listeners.forEach((l) => l(e)));
    return JamRelay.start({ port: this.opts.port ?? 8787, hotspot: this.opts.hotspot });
  }

  async stop(): Promise<void> {
    await this.handle?.remove();
    this.handle = null;
    await JamRelay.stop();
  }

  send(clientId: string, data: string) {
    void JamRelay.send({ clientId, data });
  }
  broadcast(data: string) {
    void JamRelay.broadcast({ data });
  }
  close(clientId: string) {
    void JamRelay.close({ clientId });
  }
  onEvent(cb: (e: TransportEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

// Spotify App Remote reports player changes instantly; the jam controller uses
// that as a nudge to re-read playback instead of waiting for the next poll.
export const nativePlayer = {
  onPlayerState(cb: () => void): () => void {
    let handle: PluginListenerHandle | null = null;
    let removed = false;
    void SpotifyRemote.addListener("playerState", cb).then((h) => {
      if (removed) void h.remove();
      else handle = h;
    });
    return () => {
      removed = true;
      void handle?.remove();
    };
  },
};

export type { HotspotInfo };
