import { trackMatchKey } from "../library-track";
import type { JamState, LimitRule, PlayedEntry, RuleSettings, TrackMeta } from "./types";

// Host-enforced rules for what may be added to the jam. They're checked when a
// song is added (single add, or an album/playlist being expanded); changing a
// rule later doesn't remove songs that are already queued.

export type SkipReason = "repeat" | "duplicate" | "artist" | "album" | "full";

export type RuleResult =
  | { ok: true }
  | { ok: false; reason: SkipReason; message: string };

const norm = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();

const artistKeys = (t: Pick<TrackMeta, "artists">) => t.artists.map((a) => a.id ?? `n:${norm(a.name)}`);
const albumKey = (t: Pick<TrackMeta, "album">) => t.album.id ?? (t.album.name ? `n:${norm(t.album.name)}` : null);

// Everything that counts toward a rule right now.
function counted(state: JamState, scope: LimitRule["scope"]): Pick<TrackMeta, "artists" | "album">[] {
  const queued = Object.values(state.queues).flat().map((e) => e.track);
  if (scope === "queue") return [...(state.nowPlaying ? [state.nowPlaying.track] : []), ...queued];
  // The playing song is already in the play log.
  return [...state.played, ...queued];
}

export function checkAdd(state: JamState, track: TrackMeta): RuleResult {
  const s = state.settings;

  if (s.noRepeats) {
    const key = trackMatchKey(track.name, track.artists.map((a) => a.name));
    const again = state.played.some((p) => p.trackId === track.id || trackMatchKey(p.name, p.artists.map((a) => a.name)) === key);
    if (again) return { ok: false, reason: "repeat", message: "That song already played this session." };
  }

  if (!s.allowDuplicates) {
    const dupe = Object.values(state.queues).flat().find((e) => e.track.id === track.id);
    if (dupe) {
      const who = state.members[dupe.memberId]?.name ?? "someone";
      return { ok: false, reason: "duplicate", message: `Already queued by ${who}.` };
    }
  }

  const artistLimit = s.maxPerArtist;
  if (artistLimit.limit !== null) {
    const pool = counted(state, artistLimit.scope);
    for (const a of track.artists) {
      const key = a.id ?? `n:${norm(a.name)}`;
      const n = pool.filter((t) => artistKeys(t).includes(key)).length;
      if (n >= artistLimit.limit) {
        return { ok: false, reason: "artist", message: `Limit reached: ${artistLimit.limit} ${artistLimit.limit === 1 ? "song" : "songs"} by ${a.name} ${scopeText(artistLimit.scope)}.` };
      }
    }
  }

  const albumLimit = s.maxPerAlbum;
  const aKey = albumKey(track);
  if (albumLimit.limit !== null && aKey) {
    const n = counted(state, albumLimit.scope).filter((t) => albumKey(t) === aKey).length;
    if (n >= albumLimit.limit) {
      return { ok: false, reason: "album", message: `Limit reached: ${albumLimit.limit} ${albumLimit.limit === 1 ? "song" : "songs"} from ${track.album.name} ${scopeText(albumLimit.scope)}.` };
    }
  }

  return { ok: true };
}

const scopeText = (scope: LimitRule["scope"]) => (scope === "session" ? "this session" : "in the queue");

export function playedEntry(track: TrackMeta, memberId: string | null, at: number): PlayedEntry {
  return {
    trackId: track.id,
    name: track.name,
    artists: track.artists.map((a) => ({ id: a.id, name: a.name })),
    album: { id: track.album.id, name: track.album.name },
    memberId,
    at,
  };
}

// Human-readable rules for the people joining ("what will get rejected?").
export function describeRules(s: RuleSettings): string[] {
  const out: string[] = [];
  if (s.noRepeats) out.push("Each song can only play once this session");
  else if (!s.allowDuplicates) out.push("A song can't be queued twice at the same time");
  if (s.maxPerArtist.limit !== null) out.push(`Max ${s.maxPerArtist.limit} per artist ${scopeText(s.maxPerArtist.scope)}`);
  if (s.maxPerAlbum.limit !== null) out.push(`Max ${s.maxPerAlbum.limit} per album ${scopeText(s.maxPerAlbum.scope)}`);
  out.push(`Up to ${s.maxQueuePerMember} songs in your queue`);
  return out;
}

const SKIP_TEXT: Record<SkipReason, string> = {
  repeat: "already played",
  duplicate: "already queued",
  artist: "over the artist limit",
  album: "over the album limit",
  full: "queue full",
};

export function describeAdd(added: number, skipped: { reason: SkipReason; count: number }[]): string {
  const total = skipped.reduce((n, s) => n + s.count, 0);
  const head = `Added ${added} ${added === 1 ? "song" : "songs"}`;
  if (total === 0) return head + ".";
  return `${head}. Skipped ${total}: ${skipped.map((s) => `${s.count} ${SKIP_TEXT[s.reason]}`).join(", ")}.`;
}
