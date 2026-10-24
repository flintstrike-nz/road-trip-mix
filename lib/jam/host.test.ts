import { describe, expect, it } from "vitest";
import { track, makeHost } from "./test-utils";

describe("JamHost", () => {
  it("rejects a wrong join code and accepts the right one", () => {
    const { host, sent, state } = makeHost();
    host.handleRaw("c1", JSON.stringify({ t: "hello", deviceId: "ann", name: "Ann", code: "NOPE" }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "bad-code" });
    host.handleRaw("c1", JSON.stringify({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode.toLowerCase() }));
    expect(sent.at(-1)?.msg).toMatchObject({ t: "welcome", memberId: "ann" });
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
    join("c1", "ann", "Ann");
    host.handleRaw("c1", JSON.stringify({ t: "add", track: { ...track(1), uri: "spotify:track:evil", extra: "x", album: { name: "A", imageUrl: "http://insecure/x.png" } } }));
    const entry = host.getState().queues.ann[0];
    expect(entry.track.uri).toBe(track(1).uri);
    expect((entry.track as Record<string, unknown>).extra).toBeUndefined();
    expect(entry.track.album.imageUrl).toBeUndefined();
  });

  it("enforces per-member queue limits and duplicate detection", () => {
    const { host, join } = makeHost();
    join("c1", "ann", "Ann");
    join("c2", "bob", "Bob");
    host.setSettings("host", { maxQueuePerMember: 2 });
    expect(host.addTrack("ann", track(1)).ok).toBe(true);
    expect(host.addTrack("bob", track(1))).toMatchObject({ ok: false, code: "duplicate" });
    expect(host.addTrack("ann", track(2)).ok).toBe(true);
    expect(host.addTrack("ann", track(3))).toMatchObject({ ok: false, code: "queue-full" });
    host.setSettings("host", { allowDuplicates: true });
    expect(host.addTrack("bob", track(1)).ok).toBe(true);
  });

  it("only lets members edit their own queue; the host can edit anyone's", () => {
    const { host, join } = makeHost();
    join("c1", "ann", "Ann");
    join("c2", "bob", "Bob");
    const r = host.addTrack("ann", track(1));
    const id = r.ok ? r.entryId! : "";
    expect(host.removeEntry("bob", id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.moveEntry("bob", id, 0)).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.removeEntry("host", id).ok).toBe(true);
    expect(host.removeEntry("host", id)).toMatchObject({ ok: false, code: "not-found" });
  });

  it("broadcasts a higher rev after every change", () => {
    const { host, join, broadcasts } = makeHost();
    join("c1", "ann", "Ann");
    host.addTrack("ann", track(1));
    host.addTrack("ann", track(2));
    const revs = broadcasts.flatMap((b) => (b.t === "state" ? [b.state.rev] : []));
    expect(revs.length).toBeGreaterThanOrEqual(3);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(revs.length);
  });

  it("keeps a member's queue across a reconnect and de-dupes names", () => {
    const { host, join } = makeHost();
    join("c1", "ann", "Ann");
    host.addTrack("ann", track(1));
    host.clientDisconnected("c1");
    expect(host.getState().members.ann.online).toBe(false);
    join("c9", "ann", "Ann");
    expect(host.getState().members.ann.online).toBe(true);
    expect(host.getState().queues.ann).toHaveLength(1);
    join("c2", "ann2", "Ann");
    expect(host.getState().members.ann2.name).toBe("Ann 2");
  });

  it("kicks and bans a device, dropping its queue", () => {
    const { host, join, closed, sent } = makeHost();
    join("c1", "ann", "Ann");
    host.addTrack("ann", track(1));
    expect(host.kick("ann", "ann")).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.kick("host", "ann").ok).toBe(true);
    expect(closed).toEqual(["c1"]);
    expect(sent.some((s) => s.to === "c1" && s.msg.t === "kicked")).toBe(true);
    expect(host.getState().members.ann).toBeUndefined();
    expect(host.upcoming()).toEqual([]);
    join("c2", "ann", "Ann");
    expect(sent.at(-1)?.msg).toMatchObject({ t: "error", code: "banned" });
  });

  it("lets the host reorder the rotation", () => {
    const { host, join, order } = makeHost();
    join("c1", "ann", "Ann");
    host.addTrack("host", track("h"));
    host.addTrack("ann", track("a"));
    expect(order()).toEqual(["Song h", "Song a"]);
    expect(host.reorderMembers("ann", ["ann", "host"])).toMatchObject({ ok: false });
    expect(host.reorderMembers("host", ["ann", "host"]).ok).toBe(true);
    expect(order()).toEqual(["Song a", "Song h"]);
    expect(host.reorderMembers("host", ["ann"])).toMatchObject({ ok: false, code: "bad-request" });
  });

  it("answers searches and rate limits rapid ones", async () => {
    const { host, join, sent } = makeHost({ search: async (q) => [track(q)] });
    join("c1", "ann", "Ann");
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
