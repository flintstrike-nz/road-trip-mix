import { SpotifyApiError } from "../spotify-api";
import type { PlaybackSnapshot } from "./spotify-backend";

// Polls Spotify's playback state and reports when the playing track changes.
// On Android the Spotify App Remote SDK also nudges `poke()` the instant the
// player state changes, so history and the rotation don't wait for the next
// poll.

export type TrackerEvents = {
  // `previous` is the last snapshot seen for the track that just ended.
  onChange: (next: PlaybackSnapshot, previous: PlaybackSnapshot | null) => void;
  onIdle?: (previous: PlaybackSnapshot | null) => void;
  onError?: (e: unknown) => void;
};

export class PlaybackTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last: PlaybackSnapshot | null = null;
  private running = false;
  private inFlight = false;
  private backoffUntil = 0;
  private firstReadDone: (() => void) | null = null;

  // Resolves once the first playback read has finished (successfully or not), so callers
  // can avoid acting on "nothing is playing" when they simply haven't asked yet.
  readonly firstRead = new Promise<void>((resolve) => {
    this.firstReadDone = resolve;
  });

  constructor(
    private read: () => Promise<PlaybackSnapshot | null>,
    private events: TrackerEvents,
    private opts: { intervalMs?: number; now?: () => number } = {}
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Force an immediate read (e.g. native player-state event).
  poke(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    let delay = this.opts.intervalMs ?? 4000;
    try {
      if (this.now() < this.backoffUntil) {
        delay = this.backoffUntil - this.now();
      } else {
        this.step(await this.read());
      }
    } catch (e) {
      if (e instanceof SpotifyApiError && e.status === 429) {
        delay = Math.max(delay, (e.retryAfterSec ?? 5) * 1000);
        this.backoffUntil = this.now() + delay;
      }
      this.events.onError?.(e);
    } finally {
      this.inFlight = false;
      this.firstReadDone?.();
      this.firstReadDone = null;
      if (this.running) this.timer = setTimeout(() => void this.tick(), delay);
    }
  }

  // Exposed for tests.
  step(snap: PlaybackSnapshot | null): void {
    const prev = this.last;
    if (!snap?.track) {
      if (prev?.track) this.events.onIdle?.(prev);
      this.last = snap?.track ? snap : null;
      return;
    }
    const changed = !prev?.track || prev.track.id !== snap.track.id;
    // Same song restarted (repeat or scrubbed back to the start) counts as a new play.
    const restarted =
      !changed && prev!.progressMs > 15000 && snap.progressMs < 3000 && prev!.progressMs > snap.progressMs + 10000;
    this.last = snap;
    if (changed || restarted) this.events.onChange(snap, prev);
  }
}
