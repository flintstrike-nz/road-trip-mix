import { describe, expect, it } from "vitest";
import { SongSet, dedupeAcrossPlaylists, songKeys, uniqueSongs, uniqueUris } from "./dedupe";

const t = (id: string, name: string, artist: string) => ({ id, name, artists: [{ name: artist }] });

describe("same song", () => {
  it("matches by Spotify id even when the title is different", () => {
    const s = new SongSet();
    expect(s.add(t("abc", "Song", "A"))).toBe(true);
    expect(s.add(t("abc", "Song (Remastered)", "A"))).toBe(false);
  });

  it("matches the same title and artist on different releases (different ids)", () => {
    const s = new SongSet();
    s.add(t("id1", "Dancing Queen", "ABBA"));
    expect(s.has(t("id2", "Dancing Queen", "ABBA"))).toBe(true); // album vs greatest-hits copy
  });

  it("ignores case and punctuation, but not a different artist", () => {
    const s = new SongSet();
    s.add(t("1", "Don't Stop Believin'", "Journey"));
    expect(s.has(t("2", "DONT STOP BELIEVIN", "journey"))).toBe(true);
    expect(s.has(t("3", "Don't Stop Believin'", "Glee Cast"))).toBe(false); // a cover is a different recording
  });

  it("treats apostrophes (straight or curly) and accents as the same song", () => {
    const s = new SongSet();
    s.add(t("1", "Don\u2019t Stop Me Now", "Queen"));
    expect(s.has(t("2", "Don't Stop Me Now", "Queen"))).toBe(true);
    s.add(t("3", "Halo", "Beyonc\u00e9"));
    expect(s.has(t("4", "Halo", "Beyonce"))).toBe(true);
  });

  it("doesn't confuse different songs by the same artist", () => {
    expect(uniqueSongs([t("1", "Waterloo", "ABBA"), t("2", "Fernando", "ABBA")])).toHaveLength(2);
  });

  it("accepts artists as plain strings (Collaborative Mix tracks)", () => {
    const a = { id: "x", name: "Song", artists: ["Artist"] };
    const b = { id: "y", name: "song", artists: ["ARTIST"] };
    expect(uniqueSongs([a, b])).toEqual([a]);
  });

  it("tolerates a track with no artists", () => {
    expect(() => songKeys({ id: "z", name: "Instrumental", artists: [] })).not.toThrow();
    expect(uniqueSongs([{ id: "z", name: "Instrumental", artists: [] }, { id: "z", name: "Instrumental", artists: [] }])).toHaveLength(1);
  });
});

describe("uniqueSongs", () => {
  it("keeps the first occurrence and the original order", () => {
    const out = uniqueSongs([t("1", "A", "x"), t("2", "B", "x"), t("1", "A", "x"), t("3", "C", "x"), t("4", "B", "x")]);
    expect(out.map((s) => s.id)).toEqual(["1", "2", "3"]);
  });
});

describe("dedupeAcrossPlaylists", () => {
  it("keeps a shared song only in the earliest playlist and counts what it removed", () => {
    const dad = { playlistId: "dad", tracks: [t("1", "Shared", "X"), t("2", "Dad only", "X")] };
    const mum = { playlistId: "mum", tracks: [t("3", "Mum only", "Y"), t("9", "Shared", "X")] }; // same song, other id
    const kids = { playlistId: "kids", tracks: [t("1", "Shared", "X"), t("4", "Kids only", "Z")] };
    const { playlists, removed } = dedupeAcrossPlaylists([dad, mum, kids]);
    expect(removed).toBe(2);
    expect(playlists.map((p) => p.tracks.map((s) => s.name))).toEqual([
      ["Shared", "Dad only"],
      ["Mum only"],
      ["Kids only"],
    ]);
  });

  it("removes repeats inside a single playlist too", () => {
    const { playlists, removed } = dedupeAcrossPlaylists([{ playlistId: "a", tracks: [t("1", "S", "x"), t("1", "S", "x")] }]);
    expect(removed).toBe(1);
    expect(playlists[0].tracks).toHaveLength(1);
  });

  it("changes nothing when there are no duplicates", () => {
    const input = [{ playlistId: "a", tracks: [t("1", "A", "x")] }, { playlistId: "b", tracks: [t("2", "B", "x")] }];
    const { playlists, removed } = dedupeAcrossPlaylists(input);
    expect(removed).toBe(0);
    expect(playlists).toEqual(input);
  });

  it("keeps the same track objects, so callers can still look them up by identity", () => {
    const a = t("1", "A", "x");
    const { playlists } = dedupeAcrossPlaylists([{ playlistId: "p", tracks: [a] }]);
    expect(playlists[0].tracks[0]).toBe(a);
  });
});

describe("uniqueUris", () => {
  it("drops repeated URIs, keeping the first", () => {
    expect(uniqueUris(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});
