import { describe, expect, it } from "vitest";
import { HistoryRecorder, MemoryHistoryStore } from "./history";
import { PlaybackTracker } from "./jam/tracker";
import type { PlaybackSnapshot } from "./jam/spotify-backend";
import { track } from "./jam/test-utils";

const snap = (n: string, progressMs: number, isPlaying = true): PlaybackSnapshot => ({
  isPlaying, progressMs, track: track(n), contextUri: null, deviceName: "Phone", fetchedAt: 0,
});

describe("PlaybackTracker", () => {
  const make = () => {
    const events: string[] = [];
    const t = new PlaybackTracker(async () => null, {
      onChange: (n, p) => events.push(`change:${n.track!.name}<-${p?.track?.name ?? "none"}`),
      onIdle: (p) => events.push(`idle:${p?.track?.name}`),
    });
    return { t, events };
  };

  it("reports the first track, track changes, and going idle", () => {
    const { t, events } = make();
    t.step(snap("1", 1000));
    t.step(snap("1", 5000));
    t.step(snap("2", 500));
    t.step(null);
    t.step(null);
    expect(events).toEqual(["change:Song 1<-none", "change:Song 2<-Song 1", "idle:Song 2"]);
  });

  it("counts a restart of the same song as a new play", () => {
    const { t, events } = make();
    t.step(snap("1", 120000));
    t.step(snap("1", 1000));
    expect(events).toHaveLength(2);
  });

  it("does not treat a small scrub back as a new play", () => {
    const { t, events } = make();
    t.step(snap("1", 60000));
    t.step(snap("1", 50000));
    expect(events).toHaveLength(1);
  });
});

describe("HistoryRecorder", () => {
  it("records completed and skipped plays with metadata and who added them", async () => {
    const store = new MemoryHistoryStore();
    let now = 1000;
    const rec = new HistoryRecorder(store, () => now);
    const info = (n: string) => ({ track: track(n), source: "jam" as const, jamId: "j1", addedBy: { memberId: "ann", name: "Ann" }, round: 0 });

    await rec.begin(info("1"));
    now = 200000;
    await rec.end(179000); // played to the end
    await rec.begin(info("2"));
    now = 205000;
    await rec.end(4000); // skipped after 4s
    await rec.end(0); // no open record: harmless

    const rows = await store.list();
    expect(rows.map((r) => [r.track.name, r.completed, r.skipped])).toEqual([
      ["Song 2", false, true],
      ["Song 1", true, false],
    ]);
    expect(rows[1].addedBy?.name).toBe("Ann");
    expect(await store.list({ trackId: track("1").id })).toHaveLength(1);
    expect(await store.list({ before: 200000 })).toHaveLength(1);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});
