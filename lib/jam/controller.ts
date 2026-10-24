import { HistoryRecorder, type HistoryStore } from "../history";
import type { TokenSource } from "../spotify-api";
import { lockedCount, syncPlaylistLive } from "../spotify-sync";
import { JamHost, type HostDeps } from "./host";
import type { ServerMessage } from "./protocol";
import { getPlayback, playlistUri, searchTracks, type PlaybackSnapshot } from "./spotify-backend";
import { PlaybackTracker } from "./tracker";
import type { HostTransport, TransportInfo } from "./transport";
import type { JamState } from "./types";

// Glues the pieces together on the host device: transport <-> JamHost <->
// Spotify (search, live playlist sync, now-playing) <-> play history.

export type SyncStatus = { state: "idle" | "syncing" | "error"; message?: string; lastSyncedAt?: number };

export type ControllerOptions = {
  state: JamState;
  transport: HostTransport;
  tokens: TokenSource;
  history: HistoryStore;
  onPersist?: (state: JamState) => void;
  onUpdate?: () => void;
  syncDebounceMs?: number;
  pollIntervalMs?: number;
  // Optional native player (Spotify App Remote on Android) for instant track events.
  nativePlayer?: { onPlayerState: (cb: () => void) => () => void };
  // Test seams.
  readPlayback?: () => Promise<PlaybackSnapshot | null>;
  search?: HostDeps["search"];
};

export class JamController {
  readonly host: JamHost;
  info: TransportInfo | null = null;
  syncStatus: SyncStatus = { state: "idle" };
  playback: PlaybackSnapshot | null = null;

  private tracker: PlaybackTracker;
  private recorder: HistoryRecorder;
  private unsubs: (() => void)[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private dirty = false;
  private stopped = false;

  constructor(private o: ControllerOptions) {
    const { transport } = o;
    this.host = new JamHost(o.state, {
      now: Date.now,
      genId: () => globalThis.crypto.randomUUID(),
      search: o.search ?? ((q) => searchTracks(o.tokens, q)),
      send: (clientId, msg) => transport.send(clientId, JSON.stringify(msg satisfies ServerMessage)),
      broadcast: (msg) => transport.broadcast(JSON.stringify(msg satisfies ServerMessage)),
      close: (clientId) => transport.close(clientId),
      onChange: (s) => this.changed(s),
    });
    this.recorder = new HistoryRecorder(o.history);
    this.tracker = new PlaybackTracker(
      o.readPlayback ?? (() => getPlayback(o.tokens)),
      {
        onChange: (next, prev) => void this.onTrackChange(next, prev),
        onIdle: (prev) => void this.recorder.end(prev?.progressMs ?? 0),
        onError: (e) => this.setSync({ state: "error", message: e instanceof Error ? e.message : String(e) }, false),
      },
      { intervalMs: o.pollIntervalMs }
    );
  }

  async start(): Promise<TransportInfo> {
    this.unsubs.push(
      this.o.transport.onEvent((e) => {
        if (e.type === "connected") this.host.clientConnected();
        else if (e.type === "disconnected") this.host.clientDisconnected(e.clientId);
        else this.host.handleRaw(e.clientId, e.data);
      })
    );
    this.info = await this.o.transport.start();
    if (this.o.nativePlayer) this.unsubs.push(this.o.nativePlayer.onPlayerState(() => this.tracker.poke()));
    this.tracker.start();
    this.scheduleSync();
    return this.info;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.tracker.stop();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    await this.recorder.end(this.playback?.progressMs ?? 0);
    await this.o.transport.stop();
  }

  syncNow(): void {
    this.scheduleSync(0);
  }

  // --- internals -----------------------------------------------------------

  private changed(s: JamState) {
    this.o.onPersist?.(s);
    this.o.onUpdate?.();
    this.scheduleSync();
  }

  private setSync(status: SyncStatus, notify = true) {
    this.syncStatus = status;
    if (notify) this.o.onUpdate?.();
  }

  private async onTrackChange(next: PlaybackSnapshot, prev: PlaybackSnapshot | null): Promise<void> {
    this.playback = next;
    if (prev) await this.recorder.end(estimateEnd(prev, next));
    const track = next.track;
    if (!track) return;
    const s = this.host.getState();
    const item = this.host.trackStarted(track);
    const member = item.memberId ? s.members[item.memberId] : undefined;
    await this.recorder.begin({
      track,
      source: item.memberId ? "jam" : item.entryId.startsWith("base:") ? "filler" : "external",
      jamId: s.id,
      jamName: s.name,
      playlistId: s.targetPlaylistId,
      addedBy: member ? { memberId: member.id, name: member.name } : undefined,
      round: item.round ?? undefined,
      deviceName: next.deviceName ?? undefined,
      listeners: Object.values(s.members).filter((m) => m.online).map((m) => m.name),
    });
  }

  private scheduleSync(delay = this.o.syncDebounceMs ?? 350) {
    if (this.stopped || !this.host.getState().targetPlaylistId) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.runSync(), delay);
  }

  // Coalesces bursts of edits: at most one sync in flight, and one more
  // afterwards if anything changed meanwhile.
  private async runSync(): Promise<void> {
    if (this.syncing) {
      this.dirty = true;
      return;
    }
    const s = this.host.getState();
    const playlistId = s.targetPlaylistId;
    if (!playlistId) return;
    this.syncing = true;
    this.setSync({ ...this.syncStatus, state: "syncing" });
    try {
      const upcoming = this.host.upcoming().map((u) => u.track.uri);
      const playingUri = s.nowPlaying?.track.uri ?? null;
      await syncPlaylistLive(this.o.tokens, playlistId, upcoming, (uris) => {
        // Lock through the playing song when it's in the playlist; if something
        // else is playing, keep the last known lock so history isn't rewritten.
        const found = lockedCount(uris, playingUri);
        if (found > 0) {
          this.host.setPlaylistLocked(found);
          return found;
        }
        return Math.min(s.playlistLocked, uris.length);
      });
      this.setSync({ state: "idle", lastSyncedAt: Date.now() });
    } catch (e) {
      this.setSync({ state: "error", message: e instanceof Error ? e.message : "Playlist sync failed." });
    } finally {
      this.syncing = false;
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        this.scheduleSync(0);
      }
    }
  }
}

// Best guess at how far into the track we were when it ended. Playback state is
// polled, so extrapolate a little (never more than 6s, and only while playing)
// to tell a track that finished naturally from one that was skipped.
export function estimateEnd(prev: PlaybackSnapshot, next: PlaybackSnapshot): number {
  if (!prev.isPlaying) return prev.progressMs;
  const gap = Math.max(0, Math.min(next.fetchedAt - prev.fetchedAt, 6000));
  return prev.progressMs + gap;
}

export { playlistUri };
