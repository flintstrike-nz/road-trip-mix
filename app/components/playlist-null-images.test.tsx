import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EnrichedTrack, PlaylistMeta } from "../(pages)/playlist/[id]/types";
import PlaylistHeader from "./PlaylistHeader";
import TrackRow from "./TrackRow";

// Spotify returns `images: null` (not []) for playlists without cover art, such as a brand-new
// or empty one, which is what Jam mode creates. These crashed the whole /playlist/[id] page.

const playlist = (over: Record<string, unknown> = {}): PlaylistMeta =>
  ({
    id: "p1",
    name: "Road Trip Jam",
    description: "",
    images: null,
    owner: { display_name: "Dad" },
    tracks: { total: 0 },
    ...over,
  }) as unknown as PlaylistMeta;

const track = (over: Record<string, unknown> = {}): EnrichedTrack =>
  ({
    id: "t1",
    name: "Song",
    duration_ms: 185000,
    artists: [{ id: "a1", name: "Artist" }],
    album: { name: "Album", images: null },
    genres: [],
    audioFeatures: null,
    ...over,
  }) as unknown as EnrichedTrack;

describe("playlist page components with missing artwork", () => {
  it("renders the header for a playlist whose images are null", () => {
    const html = renderToStaticMarkup(<PlaylistHeader playlist={playlist()} trackCount={0} />);
    expect(html).toContain("Road Trip Jam");
    expect(html).toContain("playlist-cover-placeholder");
  });

  it("renders the header for an empty images list and a missing owner", () => {
    const html = renderToStaticMarkup(<PlaylistHeader playlist={playlist({ images: [], owner: null, tracks: null })} trackCount={3} />);
    expect(html).toContain("playlist-cover-placeholder");
    expect(html).toContain("3 songs");
  });

  it("still shows the cover when there is one", () => {
    const html = renderToStaticMarkup(
      <PlaylistHeader playlist={playlist({ images: [{ url: "https://i.scdn.co/image/abc" }] })} trackCount={0} />
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("playlist-cover-placeholder");
  });

  it("renders a track whose album has null images", () => {
    const html = renderToStaticMarkup(<TrackRow track={track()} index={0} />);
    expect(html).toContain("Song");
    expect(html).toContain("3:05");
  });
});
