import { describe, expect, it } from "vitest";
import { describeAdd, describeRules } from "./rules";
import { makeHost, track, trackBy } from "./test-utils";

describe("no-repeat rule", () => {
  it("refuses a song that already played this session, but only when enabled", () => {
    const { host } = makeHost();
    host.trackStarted(track(1));
    expect(host.addTrack("host", track(1)).ok).toBe(true); // rule off
    host.removeEntry("host", host.getState().queues.host[0].id);

    host.setSettings("host", { noRepeats: true });
    expect(host.addTrack("host", track(1))).toMatchObject({ ok: false, code: "rule-repeat" });
    expect(host.addTrack("host", track(2)).ok).toBe(true);
  });

  it("also catches the same song on a different release (same title and artist)", () => {
    const { host } = makeHost();
    host.setSettings("host", { noRepeats: true });
    host.trackStarted(trackBy(1, "Queen", "Greatest Hits"));
    const reissue = { ...trackBy(2, "Queen", "Greatest Hits II"), name: "Song 1" };
    expect(host.addTrack("host", reissue)).toMatchObject({ ok: false, code: "rule-repeat" });
  });

  it("counts filler and external plays too, and keeps counting after they leave the queue", () => {
    const { host } = makeHost({ base: [track("f1")] });
    host.setSettings("host", { noRepeats: true });
    host.trackStarted(track("f1"));
    host.trackStarted(track("ext"));
    expect(host.addTrack("host", track("f1")).ok).toBe(false);
    expect(host.addTrack("host", track("ext")).ok).toBe(false);
  });

  it("still blocks queueing the same song twice at once unless duplicates are allowed", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack("host", track(1));
    expect(host.addTrack(ann, track(1))).toMatchObject({ ok: false, code: "duplicate" });
    host.setSettings("host", { allowDuplicates: true });
    expect(host.addTrack(ann, track(1)).ok).toBe(true);
  });
});

describe("per-artist and per-album limits", () => {
  it("limits songs per artist across everyone's queues", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.setSettings("host", { maxPerArtist: { limit: 2, scope: "queue" } });
    expect(host.addTrack("host", trackBy(1, "ABBA", "A")).ok).toBe(true);
    expect(host.addTrack(ann, trackBy(2, "ABBA", "B")).ok).toBe(true);
    expect(host.addTrack(host.getState().hostMemberId, trackBy(3, "ABBA", "C"))).toMatchObject({ ok: false, code: "rule-artist" });
    expect(host.addTrack(ann, trackBy(4, "Queen", "D")).ok).toBe(true);
  });

  it("matches artists by name regardless of case or punctuation", () => {
    const { host } = makeHost();
    host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    host.addTrack("host", trackBy(1, "AC/DC", "x"));
    expect(host.addTrack("host", trackBy(2, "ac dc", "y")).ok).toBe(false);
  });

  it("applies to any credited artist, not just the first", () => {
    const { host } = makeHost();
    host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    host.addTrack("host", trackBy(1, "Solo", "x"));
    const duet = { ...trackBy(2, "Other", "y"), artists: [{ name: "Other" }, { name: "Solo" }] };
    expect(host.addTrack("host", duet)).toMatchObject({ ok: false, code: "rule-artist" });
  });

  it("queue scope forgets songs once they've played; session scope doesn't", () => {
    const queueScope = makeHost();
    queueScope.host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    queueScope.host.addTrack("host", trackBy(1, "ABBA", "A"));
    queueScope.host.trackStarted(trackBy(1, "ABBA", "A"));
    queueScope.host.trackStarted(track("other")); // ABBA song is no longer playing or queued
    expect(queueScope.host.addTrack("host", trackBy(2, "ABBA", "B")).ok).toBe(true);

    const sessionScope = makeHost();
    sessionScope.host.setSettings("host", { maxPerArtist: { limit: 1, scope: "session" } });
    sessionScope.host.trackStarted(trackBy(1, "ABBA", "A"));
    sessionScope.host.trackStarted(track("other"));
    expect(sessionScope.host.addTrack("host", trackBy(2, "ABBA", "B"))).toMatchObject({ ok: false, code: "rule-artist" });
  });

  it("queue scope counts the song that's playing right now", () => {
    const { host } = makeHost();
    host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    host.trackStarted(trackBy(1, "ABBA", "A"));
    expect(host.addTrack("host", trackBy(2, "ABBA", "B")).ok).toBe(false);
  });

  it("limits songs per album", () => {
    const { host } = makeHost();
    host.setSettings("host", { maxPerAlbum: { limit: 2, scope: "queue" } });
    expect(host.addTrack("host", trackBy(1, "A1", "Same Album")).ok).toBe(true);
    expect(host.addTrack("host", trackBy(2, "A2", "Same Album")).ok).toBe(true);
    expect(host.addTrack("host", trackBy(3, "A3", "Same Album"))).toMatchObject({ ok: false, code: "rule-album" });
    expect(host.addTrack("host", trackBy(4, "A4", "Other Album")).ok).toBe(true);
  });

  it("prefers Spotify ids over names when present", () => {
    const { host } = makeHost();
    host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    const a = { ...track(1), artists: [{ id: "artistidAAAAAAAAAAAAAA", name: "Same Name" }] };
    const b = { ...track(2), artists: [{ id: "artistidBBBBBBBBBBBBBB", name: "Same Name" }] };
    host.addTrack("host", a);
    expect(host.addTrack("host", b).ok).toBe(true); // different artists who share a name
  });

  it("changing a rule later doesn't remove songs already queued", () => {
    const { host } = makeHost();
    host.addTrack("host", trackBy(1, "ABBA", "A"));
    host.addTrack("host", trackBy(2, "ABBA", "A"));
    host.setSettings("host", { maxPerArtist: { limit: 1, scope: "queue" } });
    expect(host.getState().queues.host).toHaveLength(2);
    expect(host.addTrack("host", trackBy(3, "ABBA", "A")).ok).toBe(false);
  });
});

describe("host-only rule settings", () => {
  it("rejects changes from anyone but the host and clamps silly values", () => {
    const { host, join } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    expect(host.setSettings(ann, { noRepeats: true })).toMatchObject({ ok: false, code: "forbidden" });
    expect(host.getState().settings.noRepeats).toBe(false);
    host.setSettings("host", { maxPerArtist: { limit: 9999, scope: "queue" }, maxQueuePerMember: -5 });
    expect(host.getState().settings.maxPerArtist.limit).toBe(50);
    expect(host.getState().settings.maxQueuePerMember).toBe(1);
    host.setSettings("host", { maxPerArtist: { limit: null, scope: "session" } });
    expect(host.getState().settings.maxPerArtist.limit).toBeNull();
  });

  it("publishes the rules to joiners (not the join code)", () => {
    const { host } = makeHost();
    host.setSettings("host", { noRepeats: true, maxPerAlbum: { limit: 3, scope: "session" } });
    const pub = host.publicState();
    expect(pub.settings).toMatchObject({ noRepeats: true, maxPerAlbum: { limit: 3, scope: "session" } });
    expect(JSON.stringify(pub)).not.toContain(host.getState().settings.joinCode);
  });
});

describe("rule descriptions", () => {
  it("lists only the rules that are on", () => {
    const { host } = makeHost();
    expect(describeRules(host.publicState().settings)).toEqual(["A song can't be queued twice at the same time", "Up to 25 songs in your queue"]);
    host.setSettings("host", { noRepeats: true, maxPerArtist: { limit: 2, scope: "queue" } });
    expect(describeRules(host.publicState().settings)).toEqual([
      "Each song can only play once this session",
      "Max 2 per artist in the queue",
      "Up to 25 songs in your queue",
    ]);
  });

  it("summarises an add", () => {
    expect(describeAdd(5, [])).toBe("Added 5 songs.");
    expect(describeAdd(1, [{ reason: "repeat", count: 2 }, { reason: "full", count: 1 }])).toBe("Added 1 song. Skipped 3: 2 already played, 1 queue full.");
  });
});
