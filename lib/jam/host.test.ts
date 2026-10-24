import { describe, expect, it } from "vitest";
import { track, trackBy, makeHost } from "./test-utils";

describe("JamHost", () => {
  it("rejects a wrong join code and accepts the right one", () => {
    const { host, sent, state } = makeHost();
    host.handleRaw("c1", JSON.stringify({ t: "hello", deviceId: "ann", name: "Ann", code: "NOPE" }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "bad-code" });
    host.handleRaw("c1", JSON.stringify({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode.toLowerCase() }));
    const welcome = sent.at(-1)?.msg;
    expect(welcome).toMatchObject({ t: "welcome" });
    // The member id handed out is public and must not be the device's secret token.
    expect(welcome && welcome.t === "welcome" && welcome.memberId).not.toBe("ann");
    expect(JSON.stringify(welcome)).not.toContain("devices");
  });

  it("doesn't let a joiner act as another member by claiming their (public) member id", () => {
    const { host, join, sent } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track(1));
    host.addTrack("host", track(2));

    // Mallory has seen every member id in the broadcast state and tries them as device tokens.
    const mallory = join("c9", "host", "Mallory");
    const mallory2 = join("c8", ann, "Mallory2");
    expect(mallory).not.toBe("host");
    expect(mallory2).not.toBe(ann);

    const annEntry = host.getState().queues[ann][0].id;
    host.handleRaw("c9", JSON.stringify({ t: "remove", entryId: annEntry }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "forbidden" });
    const hostEntry = host.getState().queues.host[0].id;
    host.handleRaw("c9", JSON.stringify({ t: "remove", entryId: hostEntry }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "forbidden" });
    expect(host.getState().queues[ann]).toHaveLength(1);
    expect(host.getState().queues.host).toHaveLength(1);
  });

  it("requires a hello before any other message", () => {
    const { host, sent } = makeHost();
    host.handleRaw("c1", JSON.stringify({ t: "add", track: track(1) }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "not-joined" });
  });

  it("rejects malformed and oversized frames", () => {
    const { host, sent } = makeHost();
    host.handleRaw("c1", "not json");
    host.handleRaw("c1", JSON.stringify({ t: "add", track: { id: "short", name: "x" } }));
    host.handleRaw("c1", "x".repeat(20000));
    expect(sent.every((s) => s.msg.t === "error")).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("strips unknown fields and forces the uri from the id when adding", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.handleRaw("c1", JSON.stringify({ t: "add", track: { ...track(1), uri: "spotify:track:evil", extra: "x", album: { name: "A", imageUrl: "http://insecure/x.png" } } }));
    const entry = host.getState().queues[ann][0];
    expect(entry.track.uri).toBe(track(1).uri);
    expect((entry.track as Record<string, unknown>).extra).toBeUndefined();
    expect(entry.track.album.imageUrl).toBeUndefined();
  });

  it("enforces per-member queue limits and duplicate detection", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    host.setSettings("host", { maxQueuePerMember: 2 });
    expect(host.addTrack(ann, track(1)).ok).toBe(true);
    expect(host.addTrack(bob, track(1))).toMatchObject({ ok: false, code: "duplicate" });
    expect(host.addTrack(ann, track(2)).ok).toBe(true);
    expect(host.addTrack(ann, track(3))).toMatchObject({ ok: false, code: "queue-full" });
    host.setSettings("host", { allowDuplicates: true });
    expect(host.addTrack(bob, track(1)).ok).toBe(true);
  });

  it("only lets members edit their own queue; the host can edit anyone's", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    const r = host.addTrack(ann, track(1));
    const id = r.ok ? r.entryId! : "";
    expect(host.removeEntry(bob, id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.moveEntry(bob, id, 0)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.removeEntry("host", id).ok).toBe(true);
    expect(host.removeEntry("host", id)).toMatchObject({ ok: false, code: "not-found" });
  });

  it("broadcasts a higher rev after every change", () => {
    const { host, join, broadcasts } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track(1));
    host.addTrack(ann, track(2));
    const revs = broadcasts.flatMap((b) => (b.t === "state" ? [b.state.rev] : []));
    expect(revs.length).toBeGreaterThanOrEqual(3);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(revs.length);
  });

  it("keeps a member's queue across a reconnect and de-dupes names", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track(1));
    host.clientDisconnected("c1");
    expect(host.getState().members[ann].online).toBe(false);
    join("c9", "ann-dev", "Ann");
    expect(host.getState().members[ann].online).toBe(true);
    expect(host.getState().queues[ann]).toHaveLength(1);
    const ann2 = join("c2", "ann2-dev", "Ann");
    expect(host.getState().members[ann2].name).toBe("Ann 2");
  });

  it("kicks and bans a device, dropping its queue", () => {
    const { host, join, closed, sent } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track(1));
    expect(host.kick(ann, ann)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.kick("host", ann).ok).toBe(true);
    expect(closed).toEqual(["c1"]);
    expect(sent.some((s) => s.to === "c1" && s.msg.t === "kicked")).toBe(true);
    expect(host.getState().members[ann]).toBeUndefined();
    expect(host.upcoming()).toEqual([]);
    join("c2", "ann-dev", "Ann");
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "banned" });
  });

  it("lets the host reorder the rotation", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack("host", track("h"));
    host.addTrack(ann, track("a"));
    expect(order()).toEqual(["Song h", "Song a"]);
    expect(host.reorderMembers(ann, [ann, "host"])).toMatchObject({ ok: false });
    expect(host.reorderMembers("host", [ann, "host"]).ok).toBe(true);
    expect(order()).toEqual(["Song a", "Song h"]);
    expect(host.reorderMembers("host", [ann])).toMatchObject({ ok: false, code: "bad-request" });
  });

  it("answers searches and rate limits rapid ones", async () => {
    const { host, join, sent } = makeHost({ search: async (q) => ({ tracks: [track(q)], collections: [] }) });
    join("c1", "ann-dev", "Ann");
    host.handleRaw("c1", JSON.stringify({ t: "search", reqId: "r1", q: "abc" }));
    host.handleRaw("c1", JSON.stringify({ t: "search", reqId: "r2", q: "abd" }));
    await Promise.resolve();
    await Promise.resolve();
    const results = sent.filter((s) => s.msg.t === "search-result").map((s) => s.msg);
    expect(results).toHaveLength(2);
    expect(results.find((m) => m.t === "search-result" && m.reqId === "r1")).toMatchObject({ tracks: [{ name: "Song abc" }] });
    expect(results.find((m) => m.t === "search-result" && m.reqId === "r2")).toMatchObject({ error: expect.any(String) });
  });
});

describe("queue tools", () => {
  it("lets members clear and shuffle their own queue, and the host anyone's", () => {
    // a deterministic "random" so the shuffle is predictable
    let n = 0;
    const { host, join, queueIds } = makeHost({ random: () => [0.1, 0.9, 0.4, 0.7][n++ % 4] });
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    ["a", "b", "c", "d", "e"].forEach((x) => host.addTrack(ann, track(x)));
    const before = queueIds(ann);

    expect(host.shuffleQueue(bob, ann)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.clearQueue(bob, ann)).toMatchObject({ ok: false, code: "forbidden" });

    expect(host.shuffleQueue(ann, ann).ok).toBe(true);
    const after = queueIds(ann);
    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort()); // same songs, new order

    expect(host.shuffleQueue("host", ann).ok).toBe(true);
    expect(host.clearQueue("host", ann).ok).toBe(true);
    expect(queueIds(ann)).toEqual([]);
    expect(host.clearQueue(ann, ann).ok).toBe(true); // clearing an empty queue is fine
    expect(host.clearQueue(ann, "nobody")).toMatchObject({ ok: false, code: "not-found" });
  });

  it("clear and shuffle work as messages from a joiner", () => {
    const { host, join, queueIds, sent } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track(1));
    host.addTrack(ann, track(2));
    host.handleRaw("c1", JSON.stringify({ t: "shuffle" }));
    expect(queueIds(ann)).toHaveLength(2);
    host.handleRaw("c1", JSON.stringify({ t: "clear" }));
    expect(queueIds(ann)).toEqual([]);
    expect(sent.some((s) => s.msg.t === "error")).toBe(false);
  });

  it("a shuffled queue changes the rotation order accordingly", () => {
    const { host, join, order } = makeHost({ random: () => 0 }); // Fisher–Yates with 0 rotates left
    const ann = join("c1", "ann-dev", "Ann");
    ["a", "b", "c"].forEach((x) => host.addTrack(ann, track(x)));
    expect(order()).toEqual(["Song a", "Song b", "Song c"]);
    host.shuffleQueue(ann, ann);
    expect(order()).toEqual(["Song b", "Song c", "Song a"]);
  });
});

describe("adding albums and playlists", () => {
  const album = [1, 2, 3, 4, 5].map((i) => track(`album${i}`));

  it("adds a whole album to the member's queue in order, in one update", async () => {
    const { host, join, queueIds, broadcasts } = makeHost({ loadCollection: async () => album });
    const ann = join("c1", "ann-dev", "Ann");
    const before = broadcasts.length;
    const r = await host.addCollection(ann, "album", "A".repeat(22));
    expect(r).toEqual({ added: 5, skipped: [] });
    expect(queueIds(ann)).toEqual(album.map((t) => t.name));
    expect(broadcasts.length - before).toBe(1); // one snapshot, not five
  });

  it("can shuffle before adding", async () => {
    const { host, join, queueIds } = makeHost({ loadCollection: async () => album, random: () => 0 });
    const ann = join("c1", "ann-dev", "Ann");
    await host.addCollection(ann, "playlist", "P".repeat(22), true);
    expect(queueIds(ann)).toEqual(["Song album2", "Song album3", "Song album4", "Song album5", "Song album1"]);
  });

  it("stops at the queue limit and applies every rule, reporting what was skipped", async () => {
    const songs = [
      trackBy("p1", "ABBA", "Gold"),
      trackBy("p2", "ABBA", "Gold"), // over the artist limit
      trackBy("p3", "Queen", "Hits"),
      trackBy("p4", "Cher", "Believe"),
      trackBy("p5", "Blur", "Parklife"), // queue full by now
    ];
    const { host, join, queueIds } = makeHost({ loadCollection: async () => songs });
    const ann = join("c1", "ann-dev", "Ann");
    host.setSettings("host", { maxQueuePerMember: 2, maxPerArtist: { limit: 1, scope: "queue" }, noRepeats: true });
    host.trackStarted(trackBy("p3", "Queen", "Hits")); // already played → repeat
    const r = await host.addCollection(ann, "playlist", "P".repeat(22));
    expect(r.added).toBe(2);
    expect(queueIds(ann)).toEqual(["Song p1", "Song p4"]);
    const byReason = Object.fromEntries(r.skipped.map((s) => [s.reason, s.count]));
    expect(byReason).toEqual({ artist: 1, repeat: 1, full: 1 });
  });

  it("caps very large playlists at 100 tracks", async () => {
    const huge = Array.from({ length: 300 }, (_, i) => track(`h${i}`));
    let asked = 0;
    const { host, join } = makeHost({ loadCollection: async (_k, _i, max) => ((asked = max), huge) });
    const ann = join("c1", "ann-dev", "Ann");
    host.setSettings("host", { maxQueuePerMember: 100 });
    const r = await host.addCollection(ann, "playlist", "P".repeat(22));
    expect(asked).toBe(100);
    expect(r.added).toBe(100);
  });

  it("works over the wire: add-result, rejects bad ids, rate limits repeats", async () => {
    const { host, join, sent, advance } = makeHost({ loadCollection: async () => album });
    join("c1", "ann-dev", "Ann");
    const id = "A".repeat(22);
    host.handleRaw("c1", JSON.stringify({ t: "add-collection", reqId: "1", kind: "album", id: "not-an-id" }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "bad-request" });

    host.handleRaw("c1", JSON.stringify({ t: "add-collection", reqId: "2", kind: "album", id }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "add-result", reqId: "2", added: 5 });

    host.handleRaw("c1", JSON.stringify({ t: "add-collection", reqId: "3", kind: "album", id }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "add-result", reqId: "3", added: 0, error: expect.any(String) });

    advance(2000);
    host.handleRaw("c1", JSON.stringify({ t: "add-collection", reqId: "4", kind: "album", id }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "add-result", reqId: "4", added: 0, skipped: [{ reason: "duplicate", count: 5 }] });
  });

  it("reports a Spotify failure instead of crashing", async () => {
    const { host, join, sent } = makeHost({ loadCollection: async () => { throw new Error("Spotify 403: private playlist"); } });
    join("c1", "ann-dev", "Ann");
    host.handleRaw("c1", JSON.stringify({ t: "add-collection", reqId: "1", kind: "playlist", id: "P".repeat(22) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "add-result", added: 0, error: "Spotify 403: private playlist" });
  });

  it("search can ask for albums and playlists", async () => {
    const col = { kind: "album" as const, id: "A".repeat(22), name: "Rumours", subtitle: "Fleetwood Mac · 1977" };
    const { host, join, sent } = makeHost({ search: async (_q, kind) => (kind === "album" ? { tracks: [], collections: [col] } : { tracks: [], collections: [] }) });
    join("c1", "ann-dev", "Ann");
    host.handleRaw("c1", JSON.stringify({ t: "search", reqId: "s", q: "rum", kind: "album" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "search-result", kind: "album", collections: [{ name: "Rumours" }] });
  });
});

describe("play log", () => {
  it("records every track that starts, once, and caps its size", () => {
    const { host } = makeHost();
    host.trackStarted(track(1));
    host.trackStarted(track(1)); // poll repeat: ignored
    host.trackStarted(track(2));
    expect(host.getState().played.map((p) => p.trackId)).toEqual([track(1).id, track(2).id]);
    for (let i = 0; i < 2100; i++) host.trackStarted(track(`l${i}`));
    expect(host.getState().played).toHaveLength(2000);
  });
});
