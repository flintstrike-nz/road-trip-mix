import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAlbumTracks, fetchPlaylistTracks, loadCollection, mapAlbum, mapPlaylist, searchCatalog } from "./spotify-backend";

const tokens = { get: async () => "tok" };

function stubFetch(routes: Record<string, unknown>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: key ? 200 : 404 });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

const rawTrack = (n: number) => ({ id: `t${n}`.padEnd(22, "x"), name: `Track ${n}`, duration_ms: 1000, artists: [{ id: "a1", name: "Artist" }] });

describe("mapping", () => {
  it("maps albums and playlists, tolerating missing fields", () => {
    expect(mapAlbum({ id: "alb", name: "Rumours", release_date: "1977-02-04", total_tracks: 11, artists: [{ name: "Fleetwood Mac" }], images: [{ url: "big" }, { url: "small" }] }))
      .toEqual({ kind: "album", id: "alb", name: "Rumours", subtitle: "Fleetwood Mac · 1977", imageUrl: "small", trackCount: 11 });
    expect(mapAlbum(null)).toBeNull();
    expect(mapPlaylist({ id: "pl", name: "Road", owner: { display_name: "Dad" }, tracks: { total: 40 } }))
      .toMatchObject({ kind: "playlist", subtitle: "by Dad", trackCount: 40 });
    expect(mapPlaylist({ id: "pl", name: "Road", items: { total: 7 } })?.trackCount).toBe(7); // newer API shape
    expect(mapPlaylist(null)).toBeNull();
  });
});

describe("searchCatalog", () => {
  it("asks Spotify for the right type and maps each kind", async () => {
    const urls = stubFetch({
      "type=album": { albums: { items: [{ id: "a1", name: "Alb", artists: [{ name: "X" }] }] } },
      "type=playlist": { playlists: { items: [null, { id: "p1", name: "Mix", owner: { display_name: "Me" } }] } },
      "type=track": { tracks: { items: [rawTrack(1)] } },
    });
    expect((await searchCatalog(tokens, "q", "album")).collections).toHaveLength(1);
    expect((await searchCatalog(tokens, "q", "playlist")).collections.map((c) => c.name)).toEqual(["Mix"]); // null dropped
    expect((await searchCatalog(tokens, "a b&c", "track")).tracks).toHaveLength(1);
    expect(urls[2]).toContain("q=a%20b%26c");
  });
});

describe("collections", () => {
  it("loads an album's tracks with the album's details folded in, across pages", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => rawTrack(i));
    const page2 = Array.from({ length: 10 }, (_, i) => rawTrack(50 + i));
    const urls = stubFetch({
      "/albums/alb/tracks?limit=50&offset=0": { total: 60, items: page1 },
      "/albums/alb/tracks?limit=50&offset=50": { total: 60, items: page2 },
      "/albums/alb": { id: "alb", name: "Rumours", release_date: "1977", images: [{ url: "img" }], artists: [{ name: "FM" }] },
    });
    const tracks = await fetchAlbumTracks(tokens, "alb");
    expect(tracks).toHaveLength(60);
    expect(tracks[0].album).toMatchObject({ id: "alb", name: "Rumours", releaseDate: "1977" });
    expect(urls.filter((u) => u.includes("/tracks")).length).toBe(2);
  });

  it("stops fetching once it has enough", async () => {
    const urls = stubFetch({
      "/albums/alb/tracks": { total: 500, items: Array.from({ length: 50 }, (_, i) => rawTrack(i)) },
      "/albums/alb": { id: "alb", name: "Big" },
    });
    expect(await fetchAlbumTracks(tokens, "alb", 50)).toHaveLength(50);
    expect(urls.filter((u) => u.includes("/tracks")).length).toBe(1);
  });

  it("loads playlist tracks, skipping episodes and unavailable items, honouring max", async () => {
    stubFetch({ "/playlists/pl/items": { total: 4, items: [{ item: rawTrack(1) }, { item: null }, { item: { ...rawTrack(2), type: "episode" } }, { item: rawTrack(3) }] } });
    expect((await fetchPlaylistTracks(tokens, "pl")).map((t) => t.name)).toEqual(["Track 1", "Track 3"]);
    expect(await loadCollection(tokens, "playlist", "pl", 1)).toHaveLength(1);
  });
});
