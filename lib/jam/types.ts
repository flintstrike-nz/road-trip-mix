// Shared types for Jam mode. These are used by the host engine (running in the
// host device's app), the Node/native relay, and the static joiner client, so
// this file must stay free of Node/DOM/React imports.

// Everything we know about a track. Spotify gives us most of this on search and
// playlist reads; `audio` and `genres` are filled in opportunistically (e.g.
// from ReccoBeats) so later "smart" features can use whatever is available.
export type TrackMeta = {
  id: string; // Spotify track id
  uri: string; // spotify:track:<id>
  name: string;
  artists: { id?: string; name: string }[];
  album: { id?: string; name: string; releaseDate?: string; imageUrl?: string };
  durationMs: number;
  explicit?: boolean;
  popularity?: number;
  isrc?: string;
  trackNumber?: number;
  discNumber?: number;
  previewUrl?: string | null;
  genres?: string[];
  audio?: {
    tempo?: number;
    key?: number;
    mode?: number;
    timeSignature?: number;
    loudness?: number;
    danceability?: number;
    energy?: number;
    valence?: number;
    acousticness?: number;
    instrumentalness?: number;
    liveness?: number;
    speechiness?: number;
  };
};

export type Member = {
  id: string; // public identity, safe to broadcast; NOT a credential (see JamState.devices)
  name: string;
  color: string;
  isHost: boolean;
  joinedAt: number;
  online: boolean;
};

export type QueueEntry = {
  id: string; // unique per queued song, so edits/reorders are idempotent
  memberId: string;
  track: TrackMeta;
  addedAt: number;
};

// Filler tracks: the unplayed remainder of an existing playlist made by this
// app. They only play when no member has anything queued.
export type BaseEntry = { id: string; track: TrackMeta };

export type PlayedMarker = {
  // Where the rotation currently is. `round` is 0-based; `turn` is the index in
  // `memberOrder` of the member whose song is playing (or just played).
  round: number;
  turn: number;
};

// "queue" counts what's playing or queued right now; "session" also counts
// everything already played in this session.
export type RuleScope = "queue" | "session";

export type LimitRule = { limit: number | null; scope: RuleScope }; // limit null = off

export type JamSettings = {
  maxQueuePerMember: number;
  allowDuplicates: boolean; // same song may be queued twice in the upcoming list
  noRepeats: boolean; // a song that already played this session can't be added again
  maxPerArtist: LimitRule; // max songs by the same artist
  maxPerAlbum: LimitRule; // max songs from the same album
  joinCode: string;
};

export type RuleSettings = Omit<JamSettings, "joinCode">;

// One entry per track that started playing this session (any source).
export type PlayedEntry = {
  trackId: string;
  name: string;
  artists: { id?: string; name: string }[];
  album: { id?: string; name: string };
  memberId: string | null;
  at: number;
};

// Albums and playlists a member can add to their queue in one go.
export type CollectionMeta = {
  kind: "album" | "playlist";
  id: string;
  name: string;
  subtitle: string; // artist(s) for albums, owner for playlists
  imageUrl?: string;
  trackCount?: number;
};

export type JamState = {
  id: string;
  name: string;
  rev: number; // bumped on every mutation; clients ignore stale snapshots
  createdAt: number;
  hostMemberId: string;
  settings: JamSettings;
  memberOrder: string[]; // rotation order; hosts can reorder
  members: Record<string, Member>;
  // Secret per-device tokens (generated on the joiner, kept in its localStorage) mapped to the
  // member they belong to. Never included in PublicJamState: knowing a member id must not let
  // you act as that member.
  devices: Record<string, string>;
  banned: string[]; // device tokens removed by the host
  played: PlayedEntry[]; // this session's play log, oldest first (capped)
  queues: Record<string, QueueEntry[]>; // per-member personal queue, in the order the member wants them played
  // Last round each member had a song locked in (played or playing); -1 = never.
  lastRound: Record<string, number>;
  cursor: PlayedMarker | null; // null until the first song starts
  nowPlaying: ScheduledItem | null;
  base: BaseEntry[];
  // How many leading playlist items are already played/playing and must not
  // be rewritten by live sync.
  playlistLocked: number;
  targetPlaylistId?: string;
  groupedPlaylistId?: string;
};

export type ScheduledItem = {
  entryId: string;
  track: TrackMeta;
  memberId: string | null; // null for filler from the base playlist
  round: number | null;
};

// The state sent to joiners: same thing, but with the derived schedule and
// without anything they don't need (e.g. the base playlist's full metadata).
export type PublicJamState = {
  id: string;
  name: string;
  rev: number;
  hostMemberId: string;
  settings: RuleSettings;
  memberOrder: string[];
  members: Record<string, Member>;
  queues: Record<string, QueueEntry[]>;
  nowPlaying: ScheduledItem | null;
  upcoming: ScheduledItem[]; // derived round-robin order, first N
  baseRemaining: number;
};
