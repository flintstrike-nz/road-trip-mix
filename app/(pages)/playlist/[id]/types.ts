export type AudioFeatures = {
  tempo: number;
  key_of: string;
  open_key: string;
  time_sig: string;
  danceability: number; // 0-100
  acousticness: number; // 0-100
  genres: string[];
};

export type EnrichedTrack = {
  id: string;
  name: string;
  duration_ms: number;
  artists: { id: string; name: string }[];
  album: { name: string; images: { url: string }[] | null };
  genres: string[];
  audioFeatures: AudioFeatures | null;
};

export type TrackItem = {
  item: {
    id: string;
    name: string;
    duration_ms: number;
    artists: { id: string; name: string }[];
    album: { name: string; images: { url: string }[] | null };
  } | null;
};

export type PlaylistMeta = {
  id: string;
  name: string;
  description: string;
  // Spotify sends null (not []) for playlists without cover art, e.g. new or empty ones.
  images: { url: string }[] | null;
  owner: { display_name: string | null } | null;
  tracks: { total: number } | null;
};
