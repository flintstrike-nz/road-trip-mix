import type { Playlist } from "@/app/components/PlaylistBox";

export async function getAllPlaylists(accessToken: string): Promise<Playlist[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const limit = 50;

  const first = await fetch(
    `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=0`,
    { headers }
  );
  if (!first.ok) {
    if (first.status === 429) {
      const retryAfter = first.headers.get("Retry-After");
      const wait = retryAfter ? ` Try again in ${retryAfter}s.` : " Try again shortly.";
      throw new Error(`Spotify rate limit hit.${wait}`);
    }
    throw new Error(`Spotify returned ${first.status} — try signing out and back in.`);
  }
  const firstData = await first.json();
  const total: number = firstData.total ?? 0;
  const items: Playlist[] = firstData.items ?? [];

  if (total > limit) {
    const offsets = Array.from(
      { length: Math.ceil((total - limit) / limit) },
      (_, i) => (i + 1) * limit
    );
    const rest = await Promise.all(
      offsets.map((offset) =>
        fetch(
          `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`,
          { headers, next: { revalidate: 60 } }
        )
          .then((r) => r.json())
          .then((d) => (d.items ?? []) as Playlist[])
      )
    );
    items.push(...rest.flat());
  }

  return items;
}

export type PlaylistMeta = { name: string; total: number };

export async function getPlaylistMeta(
  accessToken: string,
  ids: string[]
): Promise<Record<string, PlaylistMeta>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(
        `https://api.spotify.com/v1/playlists/${id}?fields=name,tracks.total`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) return [id, { name: id, total: 0 }] as [string, PlaylistMeta];
      const data = await res.json();
      return [id, { name: data.name ?? id, total: data.tracks?.total ?? 0 }] as [string, PlaylistMeta];
    })
  );
  return Object.fromEntries(entries);
}

export type SimplifiedTrack = {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string }[] | null };
  duration_ms: number;
};

// In-memory cache keyed by `${accessToken}:${playlistId}` — scoped per session.
const trackCache = new Map<string, SimplifiedTrack[]>();

// Per-token rate-limit cooldown: don't retry until this timestamp (ms).
const rateLimitedUntil = new Map<string, number>();

export async function getPlaylistTracksClient(
  accessToken: string,
  playlistId: string
): Promise<SimplifiedTrack[]> {
  const cacheKey = `${accessToken}:${playlistId}`;
  const cached = trackCache.get(cacheKey);
  if (cached) return cached;

  // Honour rate-limit cooldown — don't hammer Spotify while throttled.
  const cooldown = rateLimitedUntil.get(accessToken) ?? 0;
  if (Date.now() < cooldown) return [];

  const headers = { Authorization: `Bearer ${accessToken}` };
  const limit = 50;

  const first = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=0`,
    { headers }
  );
  if (!first.ok) {
    if (first.status === 429) {
      const retryAfter = parseInt(first.headers.get("Retry-After") ?? "30", 10);
      rateLimitedUntil.set(accessToken, Date.now() + retryAfter * 1000);
    }
    return [];
  }
  const firstData = await first.json();
  const total: number = firstData.total ?? 0;
  const items: { item: SimplifiedTrack | null }[] = firstData.items ?? [];

  if (total > limit) {
    const offsets = Array.from(
      { length: Math.ceil((total - limit) / limit) },
      (_, i) => (i + 1) * limit
    );
    const rest = await Promise.all(
      offsets.map((offset) =>
        fetch(
          `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`,
          { headers }
        )
          .then((r) => r.json())
          .then((d) => (d.items ?? []) as { item: SimplifiedTrack | null }[])
      )
    );
    items.push(...rest.flat());
  }

  const result = items.filter((i) => i.item != null).map((i) => i.item!);
  trackCache.set(cacheKey, result);
  return result;
}
