import { trackMatchKey } from "./library-track";

// One definition of "the same song" for every merged or collaborative playlist
// (grouped playlists, Collaborative Mix, Jam), so a song never appears twice.
//
// Two tracks are the same song if they share a Spotify id, or if their title and
// first artist match once case and punctuation are ignored. The second rule
// catches the usual real-world duplicate: the same song on an album, a single
// and a compilation, each with its own id.

type Named = { name: string; artists: ({ name: string } | string)[] };

const artistName = (a: { name: string } | string | undefined) => (typeof a === "string" ? a : a?.name ?? "");

export function songKeys(t: Named & { id?: string }): string[] {
  const keys = [`name:${trackMatchKey(t.name, [artistName(t.artists[0])])}`];
  if (t.id) keys.push(`id:${t.id}`);
  return keys;
}

// Tracks seen so far; `add` returns false if the song was already present.
export class SongSet {
  private seen: Set<string>;

  // Optionally start from keys collected earlier (see `keys`), copied so the original is untouched.
  constructor(initial?: Iterable<string>) {
    this.seen = new Set(initial);
  }

  keys(): ReadonlySet<string> {
    return this.seen;
  }

  has(t: Named & { id?: string }): boolean {
    return songKeys(t).some((k) => this.seen.has(k));
  }

  add(t: Named & { id?: string }): boolean {
    if (this.has(t)) return false;
    songKeys(t).forEach((k) => this.seen.add(k));
    return true;
  }
}

// Keeps the first occurrence of each song, in order.
export function uniqueSongs<T extends Named & { id?: string }>(tracks: T[]): T[] {
  const set = new SongSet();
  return tracks.filter((t) => set.add(t));
}

// For tracks pulled from several source playlists. A song in more than one playlist
// is kept in the earliest playlist (in the order given) and removed from the rest,
// so it takes one round-robin turn, not two. Order within each playlist is kept.
export function dedupeAcrossPlaylists<T extends Named & { id?: string }>(
  byPlaylist: { playlistId: string; tracks: T[] }[]
): { playlists: { playlistId: string; tracks: T[] }[]; removed: number } {
  const set = new SongSet();
  let removed = 0;
  const playlists = byPlaylist.map(({ playlistId, tracks }) => ({
    playlistId,
    tracks: tracks.filter((t) => {
      if (set.add(t)) return true;
      removed++;
      return false;
    }),
  }));
  return { playlists, removed };
}

// Plain Spotify URIs (e.g. just before writing to a playlist): first occurrence wins.
export function uniqueUris(uris: string[]): string[] {
  return Array.from(new Set(uris));
}
