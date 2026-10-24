import { spotifyFetch, type TokenSource } from "../spotify-api";
import type { SearchKind } from "./protocol";
import type { SearchResults } from "./host";
import type { CollectionMeta, TrackMeta } from "./types";

// Spotify Web API calls the jam host needs: track search (on behalf of
// joiners, who have no Spotify access of their own) and playback state.

type RawTrack = {
  id?: string;
  uri?: string;
  name?: string;
  type?: string;
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;
  preview_url?: string | null;
  track_number?: number;
  disc_number?: number;
  external_ids?: { isrc?: string };
  artists?: { id?: string; name?: string }[];
  album?: { id?: string; name?: string; release_date?: string; images?: { url: string }[] };
};

// Every field except id/name is optional because Spotify trims what it returns
// to apps over time; we keep whatever arrives for later smart features.
export function mapTrack(raw: RawTrack | null | undefined): TrackMeta | null {
  if (!raw?.id || !raw.name || raw.type === "episode") return null;
  return {
    id: raw.id,
    uri: raw.uri ?? `spotify:track:${raw.id}`,
    name: raw.name,
    artists: (raw.artists ?? []).map((a) => ({ id: a.id, name: a.name ?? "" })),
    album: {
      id: raw.album?.id,
      name: raw.album?.name ?? "",
      releaseDate: raw.album?.release_date,
      imageUrl: raw.album?.images?.[raw.album.images.length > 1 ? 1 : 0]?.url,
    },
    durationMs: raw.duration_ms ?? 0,
    explicit: raw.explicit,
    popularity: raw.popularity,
    isrc: raw.external_ids?.isrc,
    trackNumber: raw.track_number,
    discNumber: raw.disc_number,
    previewUrl: raw.preview_url,
  };
}

type RawAlbum = {
  id?: string;
  name?: string;
  release_date?: string;
  total_tracks?: number;
  artists?: { id?: string; name?: string }[];
  images?: { url: string }[];
};

type RawPlaylist = {
  id?: string;
  name?: string;
  owner?: { display_name?: string };
  images?: { url: string }[];
  tracks?: { total?: number };
  items?: { total?: number };
};

const smallImage = (images?: { url: string }[]) => images?.[images.length > 1 ? 1 : 0]?.url;

export function mapAlbum(a: RawAlbum | null | undefined): CollectionMeta | null {
  if (!a?.id || !a.name) return null;
  const artists = (a.artists ?? []).map((x) => x.name).filter(Boolean).join(", ");
  const year = a.release_date?.slice(0, 4);
  return {
    kind: "album",
    id: a.id,
    name: a.name,
    subtitle: [artists, year].filter(Boolean).join(" · "),
    imageUrl: smallImage(a.images),
    trackCount: a.total_tracks,
  };
}

// Search results can contain nulls for playlists Spotify has removed.
export function mapPlaylist(p: RawPlaylist | null | undefined): CollectionMeta | null {
  if (!p?.id || !p.name) return null;
  return {
    kind: "playlist",
    id: p.id,
    name: p.name,
    subtitle: p.owner?.display_name ? `by ${p.owner.display_name}` : "Playlist",
    imageUrl: smallImage(p.images),
    trackCount: p.tracks?.total ?? p.items?.total,
  };
}

export async function searchCatalog(tokens: TokenSource, query: string, kind: SearchKind = "track"): Promise<SearchResults> {
  const res = await spotifyFetch(tokens, `/search?type=${kind}&limit=10&q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (kind === "album") {
    const items: RawAlbum[] = data?.albums?.items ?? [];
    return { tracks: [], collections: items.map(mapAlbum).filter((c): c is CollectionMeta => c !== null) };
  }
  if (kind === "playlist") {
    const items: (RawPlaylist | null)[] = data?.playlists?.items ?? [];
    return { tracks: [], collections: items.map(mapPlaylist).filter((c): c is CollectionMeta => c !== null) };
  }
  const items: RawTrack[] = data?.tracks?.items ?? [];
  return { tracks: items.map(mapTrack).filter((t): t is TrackMeta => t !== null), collections: [] };
}

export async function searchTracks(tokens: TokenSource, query: string): Promise<TrackMeta[]> {
  return (await searchCatalog(tokens, query, "track")).tracks;
}

// Album track listings are "simplified" (no album object), so the album's own
// details are folded into each track.
export async function fetchAlbumTracks(tokens: TokenSource, albumId: string, max = 100): Promise<TrackMeta[]> {
  const albumRes = await spotifyFetch(tokens, `/albums/${albumId}`);
  const album: RawAlbum = await albumRes.json();
  const out: TrackMeta[] = [];
  for (let offset = 0; out.length < max; offset += 50) {
    const res = await spotifyFetch(tokens, `/albums/${albumId}/tracks?limit=50&offset=${offset}`);
    const data = await res.json();
    const items: RawTrack[] = data.items ?? [];
    for (const it of items) {
      const t = mapTrack({ ...it, album });
      if (t) out.push(t);
    }
    if (offset + 50 >= (data.total ?? 0) || items.length === 0) break;
  }
  return out.slice(0, max);
}

export async function loadCollection(tokens: TokenSource, kind: "album" | "playlist", id: string, max = 100): Promise<TrackMeta[]> {
  return kind === "album" ? fetchAlbumTracks(tokens, id, max) : fetchPlaylistTracks(tokens, id, max);
}

export type PlaybackSnapshot = {
  isPlaying: boolean;
  progressMs: number;
  track: TrackMeta | null;
  contextUri: string | null;
  deviceName: string | null;
  fetchedAt: number;
};

export async function getPlayback(tokens: TokenSource): Promise<PlaybackSnapshot | null> {
  const res = await spotifyFetch(tokens, "/me/player?additional_types=track");
  if (res.status === 204) return null;
  const d = await res.json().catch(() => null);
  if (!d) return null;
  return {
    isPlaying: !!d.is_playing,
    progressMs: d.progress_ms ?? 0,
    track: mapTrack(d.item),
    contextUri: d.context?.uri ?? null,
    deviceName: d.device?.name ?? null,
    fetchedAt: Date.now(),
  };
}

export const playlistUri = (id: string) => `spotify:playlist:${id}`;

// Full track list of a playlist (all pages), with whatever metadata Spotify returns.
export async function fetchPlaylistTracks(tokens: TokenSource, playlistId: string, max = Infinity): Promise<TrackMeta[]> {
  const out: TrackMeta[] = [];
  for (let offset = 0; out.length < max; offset += 50) {
    const res = await spotifyFetch(tokens, `/playlists/${playlistId}/items?limit=50&offset=${offset}`);
    const data = await res.json();
    const items: { item: RawTrack | null }[] = data.items ?? [];
    for (const it of items) {
      const t = mapTrack(it.item);
      if (t) out.push(t);
    }
    if (offset + 50 >= (data.total ?? 0) || items.length === 0) break;
  }
  return Number.isFinite(max) ? out.slice(0, max) : out;
}

export async function createPlaylist(tokens: TokenSource, name: string): Promise<string> {
  const res = await spotifyFetch(tokens, "/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description: "Live jam by Road Trip Mix", public: false }),
  });
  return (await res.json()).id as string;
}

// Basic transport controls via the Web API (any active Spotify device).
export const player = {
  playPlaylist: (tokens: TokenSource, playlistId: string, position = 0) =>
    spotifyFetch(tokens, "/me/player/play", {
      method: "PUT",
      body: JSON.stringify({ context_uri: playlistUri(playlistId), offset: { position } }),
    }),
  pause: (tokens: TokenSource) => spotifyFetch(tokens, "/me/player/pause", { method: "PUT" }),
  resume: (tokens: TokenSource) => spotifyFetch(tokens, "/me/player/play", { method: "PUT" }),
  next: (tokens: TokenSource) => spotifyFetch(tokens, "/me/player/next", { method: "POST" }),
};
