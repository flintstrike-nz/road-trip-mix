import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryHistoryStore } from "../history";
import { JamController } from "./controller";
import { createJamState } from "./host";
import type { PlaybackSnapshot } from "./spotify-backend";
import { track } from "./test-utils";
import type { HostTransport } from "./transport";
import type { TrackMeta } from "./types";

const uri = (n: string) => track(n).uri;
const nullTransport: HostTransport = {
  start: async () => ({ port: 1, urls: [] }),
  stop: async () => {},
  send: () => {},
  broadcast: () => {},
  close: () => {},
  onEvent: () => () => {},
};

// An in-memory Spotify playlist behind a fake fetch; records every write.
function fakeSpotify(initial: string[]) {
  const pl = { uris: [...initial], snap: 1 };
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : {};
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (method === "GET" && url.includes("/items?")) {
      const off = Number(new URL(url).searchParams.get("offset"));
      return json({ total: pl.uris.length, items: pl.uris.slice(off, off + 100).map((u) => ({ item: { uri: u } })) });
    }
    if (method === "GET") return json({ snapshot_id: String(pl.snap) });
    writes.push(method);
    if (method === "DELETE") pl.uris = pl.uris.filter((u) => !body.items.some((i: { uri: string }) => i.uri === u));
    if (method === "POST") pl.uris.push(...body.uris);
    if (method === "PUT") pl.uris = [...body.uris];
    pl.snap++;
    return json({ snapshot_id: String(pl.snap) });
  });
  return { pl, writes };
}

const snap = (t: TrackMeta, contextUri: string | null): PlaybackSnapshot => ({
  isPlaying: true, progressMs: 1000, track: t, contextUri, deviceName: "Phone", fetchedAt: Date.now(),
});

const controllers: JamController[] = [];
async function start(opts: {
  playlistLocked?: number;
  base?: TrackMeta[];
  readPlayback: () => Promise<PlaybackSnapshot | null>;
}) {
  const state = createJamState({ name: "T", hostName: "Host", hostMemberId: "host", base: opts.base, targetPlaylistId: "PL" });
  state.playlistLocked = opts.playlistLocked ?? 0;
  const history = new MemoryHistoryStore();
  const c = new JamController({
    state, transport: nullTransport, tokens: { get: async () => "t" }, history,
    readPlayback: opts.readPlayback, pollIntervalMs: 20, syncDebounceMs: 5,
  });
  controllers.push(c);
  await c.start();
  return { c, history };
}

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop();
  vi.unstubAllGlobals();
});

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("starting a jam on a playlist that is already playing", () => {
  it("doesn't touch played or playing tracks while the first playback read is still in flight", async () => {
    const sp = fakeSpotify([uri("p1"), uri("p2"), uri("f1"), uri("f2")]);
    // p2 is playing; the jam's filler is what comes after it. Spotify answers slowly.
    const { c } = await start({
      base: [track("f1"), track("f2")],
      readPlayback: async () => {
        await settle(150);
        return snap(track("p2"), "spotify:playlist:PL");
      },
    });
    await settle(500);
    expect(sp.writes).toEqual([]); // nothing was deleted or rewritten
    expect(sp.pl.uris).toEqual([uri("p1"), uri("p2"), uri("f1"), uri("f2")]);
    expect(c.host.getState().nowPlaying?.track.id).toBe(track("p2").id);
  });

  it("still syncs if Spotify never answers the first read", async () => {
    const sp = fakeSpotify([uri("f1")]);
    const { c } = await start({ base: [track("f1")], readPlayback: async () => { throw new Error("offline"); } });
    c.host.addTrack("host", track("a1"));
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("a1"), uri("f1")]));
  });
});

describe("songs that appear more than once in the playlist", () => {
  it("locks the occurrence at or after the known position, not the first one", async () => {
    // x already played at index 0; it's playing again at index 2.
    const sp = fakeSpotify([uri("x"), uri("y"), uri("x"), uri("z")]);
    const { c } = await start({
      playlistLocked: 3,
      base: [track("z")],
      readPlayback: async () => snap(track("x"), "spotify:playlist:PL"),
    });
    await vi.waitFor(() => expect(c.host.getState().nowPlaying?.track.id).toBe(track("x").id));
    c.host.addTrack("host", track("a"));
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("x"), uri("y"), uri("x"), uri("a"), uri("z")]));
    expect(sp.writes).not.toContain("PUT");
  });
});

describe("songs played from somewhere other than the jam playlist", () => {
  // Queue the song first, then let "Spotify" report it playing from `context`.
  async function playQueued(id: string, context: string | null) {
    fakeSpotify([uri("f1")]);
    let current: PlaybackSnapshot | null = null;
    const { c, history } = await start({ base: [track("f1")], readPlayback: async () => current });
    c.host.addTrack("host", track(id));
    current = snap(track(id), context);
    await vi.waitFor(async () => expect((await history.list()).length).toBe(1));
    return { c, history };
  }

  it("doesn't consume a queued song or advance the rotation, but is still recorded", async () => {
    const { c, history } = await playQueued("q1", "spotify:playlist:OTHER");
    const s = c.host.getState();
    expect(s.queues.host.map((e) => e.track.id)).toEqual([track("q1").id]); // still queued
    expect(s.cursor).toBeNull();
    expect((await history.list())[0].source).toBe("external");
    expect(s.played.map((p) => p.trackId)).toEqual([track("q1").id]); // still counts for no-repeat
  });

  it("consumes it when it's playing from the jam playlist", async () => {
    const { c, history } = await playQueued("q2", "spotify:playlist:PL");
    expect(c.host.getState().queues.host).toHaveLength(0);
    expect((await history.list())[0].source).toBe("jam");
  });

  it("when Spotify doesn't report a context, it still matches the queue", async () => {
    const { c } = await playQueued("q3", null);
    expect(c.host.getState().queues.host).toHaveLength(0);
  });
});

describe("a queued song that gets played from another playlist", () => {
  it("doesn't move the playlist lock, so the entry can still be edited and isn't duplicated", async () => {
    const sp = fakeSpotify([uri("f1"), uri("f2")]);
    let current: PlaybackSnapshot | null = null;
    const { c } = await start({ base: [track("f1"), track("f2")], readPlayback: async () => current });
    const added = c.host.addTrack("host", track("q1"));
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("q1"), uri("f1"), uri("f2")]));

    // The family plays q1 from search results, not from the jam playlist.
    current = snap(track("q1"), "spotify:playlist:OTHER");
    await vi.waitFor(() => expect(c.host.getState().nowPlaying?.track.id).toBe(track("q1").id));
    await settle(200);
    expect(sp.pl.uris).toEqual([uri("q1"), uri("f1"), uri("f2")]); // no duplicate of q1
    expect(c.host.getState().playlistLocked).toBe(0); // lock didn't jump over unplayed tracks

    // and it's still editable: removing it from the queue removes it from the playlist
    c.host.removeEntry("host", added.ok ? added.entryId! : "");
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("f1"), uri("f2")]));
  });
});
