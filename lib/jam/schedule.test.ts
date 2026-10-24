import { describe, expect, it } from "vitest";
import { track, makeHost } from "./test-utils";

describe("round-robin schedule", () => {
  it("interleaves one song per member per round", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    host.addTrack("host", track("h1"));
    host.addTrack("host", track("h2"));
    host.addTrack(ann, track("a1"));
    host.addTrack(ann, track("a2"));
    host.addTrack(bob, track("b1"));
    expect(order()).toEqual(["Song h1", "Song a1", "Song b1", "Song h2", "Song a2"]);
  });

  it("skips members with nothing queued for a round", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    host.addTrack(ann, track("a1"));
    host.addTrack(ann, track("a2"));
    host.addTrack(bob, track("b1"));
    expect(order()).toEqual(["Song a1", "Song b1", "Song a2"]);
  });

  it("puts a late add in the current round if the member's turn is still ahead", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    const bob = join("c2", "bob-dev", "Bob");
    host.addTrack("host", track("h1"));
    host.addTrack(ann, track("a1"));
    host.trackStarted(track("h1")); // host's turn in round 0 is playing
    host.addTrack(bob, track("b1")); // bob hasn't had round 0 yet
    expect(order()).toEqual(["Song a1", "Song b1"]);
    host.addTrack("host", track("h2")); // host already had round 0 → round 1
    expect(order()).toEqual(["Song a1", "Song b1", "Song h2"]);
  });

  it("does not let a member jump ahead of someone whose turn is next", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack("host", track("h1"));
    host.addTrack("host", track("h2"));
    host.addTrack(ann, track("a1"));
    host.trackStarted(track("h1"));
    host.trackStarted(track("a1")); // round 0 done; h2 is round 1
    host.addTrack(ann, track("a2")); // ann played in round 0 → round 1, after host
    expect(order()).toEqual(["Song h2", "Song a2"]);
  });

  it("reordering a personal queue changes which song gets the next slot", () => {
    const { host, join, order } = makeHost();
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track("a1"));
    const second = host.addTrack(ann, track("a2"));
    host.addTrack("host", track("h1"));
    expect(order()).toEqual(["Song h1", "Song a1", "Song a2"]);
    if (second.ok) host.moveEntry(ann, second.entryId!, 0);
    expect(order()).toEqual(["Song h1", "Song a2", "Song a1"]);
  });

  it("plays filler from the base playlist after all member songs", () => {
    const { host, order } = makeHost({ base: [track("f1"), track("f2")] });
    host.addTrack("host", track("h1"));
    expect(order()).toEqual(["Song h1", "Song f1", "Song f2"]);
  });

  it("locks a song in when it starts and removes it from the queue", () => {
    const { host, join, order, queueIds } = makeHost({ base: [track("f1")] });
    const ann = join("c1", "ann-dev", "Ann");
    host.addTrack(ann, track("a1"));
    host.trackStarted(track("a1"));
    expect(queueIds(ann)).toEqual([]);
    expect(host.getState().nowPlaying?.track.name).toBe("Song a1");
    host.trackStarted(track("f1"));
    expect(order()).toEqual([]);
  });

  it("treats an unknown track as external playback without touching the rotation", () => {
    const { host, order } = makeHost();
    host.addTrack("host", track("h1"));
    host.trackStarted(track("zzz"));
    expect(host.getState().nowPlaying?.memberId).toBeNull();
    expect(host.getState().cursor).toBeNull();
    expect(order()).toEqual(["Song h1"]);
  });
});
