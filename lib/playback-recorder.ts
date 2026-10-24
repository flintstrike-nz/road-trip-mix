import { estimateEnd } from "./jam/controller";
import { getPlayback } from "./jam/spotify-backend";
import { PlaybackTracker } from "./jam/tracker";
import { HistoryRecorder, getHistoryStore } from "./history";
import type { TokenSource } from "./spotify-api";

// Records play history while the app is open, outside of jams. While a jam is
// running its controller records instead (with who added each song), so this
// stands down to avoid double entries.

export const RECORD_FLAG_KEY = "road-trip-mix:record-history";

let jamActive = 0;
export function setJamActive(active: boolean): void {
  jamActive = Math.max(0, jamActive + (active ? 1 : -1));
}

export function startBackgroundRecorder(tokens: TokenSource, intervalMs = 8000): () => void {
  const recorder = new HistoryRecorder(getHistoryStore());
  const tracker = new PlaybackTracker(
    () => getPlayback(tokens),
    {
      onChange: (next, prev) => {
        if (jamActive > 0) return;
        void (async () => {
          if (prev) await recorder.end(estimateEnd(prev, next));
          if (next.track) {
            await recorder.begin({ track: next.track, source: "external", deviceName: next.deviceName ?? undefined });
          }
        })();
      },
      onIdle: (prev) => {
        if (jamActive === 0) void recorder.end(prev?.progressMs ?? 0);
      },
    },
    { intervalMs }
  );
  tracker.start();
  return () => tracker.stop();
}
