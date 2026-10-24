import type { PublicJamState, TrackMeta } from "./types";

// Wire protocol between joiner devices and the host. Messages are JSON text
// frames. Everything coming off the network is untrusted, so the host only ever
// sees what `parseClientMessage` returns.

export const MAX_FRAME_BYTES = 16 * 1024;
const MAX_STR = 200;

export type ClientMessage =
  | { t: "hello"; deviceId: string; name: string; code: string }
  | { t: "add"; track: TrackMeta; index?: number }
  | { t: "remove"; entryId: string }
  | { t: "move"; entryId: string; toIndex: number }
  | { t: "search"; reqId: string; q: string }
  | { t: "rename"; name: string };

export type ServerMessage =
  | { t: "welcome"; memberId: string; state: PublicJamState }
  | { t: "state"; state: PublicJamState }
  | { t: "search-result"; reqId: string; tracks: TrackMeta[]; error?: string }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "kicked" };

export type ErrorCode =
  | "bad-code"
  | "banned"
  | "not-joined"
  | "queue-full"
  | "duplicate"
  | "not-found"
  | "forbidden"
  | "rate-limited"
  | "bad-request";

const TRACK_ID = /^[A-Za-z0-9]{22}$/;

function str(v: unknown, max = MAX_STR): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Re-builds a TrackMeta from untrusted input, keeping only known fields.
// Returns null if the essentials are missing or malformed.
export function sanitizeTrack(raw: unknown): TrackMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 22);
  const name = str(r.name);
  if (!id || !TRACK_ID.test(id) || !name) return null;
  const artistsRaw = Array.isArray(r.artists) ? r.artists.slice(0, 10) : [];
  const artists = artistsRaw
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const n = str(o.name);
      return n ? { id: str(o.id, 22) ?? undefined, name: n } : null;
    })
    .filter((a): a is { id: string | undefined; name: string } => a !== null);
  const album = (r.album ?? {}) as Record<string, unknown>;
  const imageUrl = str(album.imageUrl, 500);
  const track: TrackMeta = {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists,
    album: {
      id: str(album.id, 22) ?? undefined,
      name: str(album.name) ?? "",
      releaseDate: str(album.releaseDate, 20) ?? undefined,
      imageUrl: imageUrl && /^https:\/\//.test(imageUrl) ? imageUrl : undefined,
    },
    durationMs: Math.max(0, num(r.durationMs) ?? 0),
    explicit: typeof r.explicit === "boolean" ? r.explicit : undefined,
    popularity: num(r.popularity),
    isrc: str(r.isrc, 20) ?? undefined,
    trackNumber: num(r.trackNumber),
    discNumber: num(r.discNumber),
  };
  return track;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;

  switch (m.t) {
    case "hello": {
      const deviceId = str(m.deviceId, 64);
      const name = str(m.name, 30);
      const code = str(m.code, 12);
      return deviceId && name && code ? { t: "hello", deviceId, name, code } : null;
    }
    case "add": {
      const track = sanitizeTrack(m.track);
      if (!track) return null;
      const index = typeof m.index === "number" && Number.isInteger(m.index) && m.index >= 0 ? m.index : undefined;
      return { t: "add", track, index };
    }
    case "remove": {
      const entryId = str(m.entryId, 64);
      return entryId ? { t: "remove", entryId } : null;
    }
    case "move": {
      const entryId = str(m.entryId, 64);
      const toIndex = m.toIndex;
      if (!entryId || typeof toIndex !== "number" || !Number.isInteger(toIndex) || toIndex < 0) return null;
      return { t: "move", entryId, toIndex };
    }
    case "search": {
      const reqId = str(m.reqId, 32);
      const q = str(m.q, 100);
      return reqId && q ? { t: "search", reqId, q } : null;
    }
    case "rename": {
      const name = str(m.name, 30);
      return name ? { t: "rename", name } : null;
    }
    default:
      return null;
  }
}

// Relay <-> host envelope. The relay (Node or native) only moves these around
// and never inspects `data`.
export type RelayToHost =
  | { type: "ready"; port: number; urls: string[] }
  | { type: "connected"; clientId: string }
  | { type: "disconnected"; clientId: string }
  | { type: "message"; clientId: string; data: string };

export type HostToRelay =
  | { type: "send"; clientId: string; data: string }
  | { type: "broadcast"; data: string }
  | { type: "close"; clientId: string };
