// Shared track shape used to merge library data pulled from different music
// services (Spotify, Apple Music) into one collaborative mix pipeline.

export type Provider = "spotify" | "apple";

export type LibraryTrack = {
  provider: Provider;
  id: string; // provider-native id (Spotify track id, or Apple Music catalog song id)
  name: string;
  artists: string[];
  albumName: string;
  imageUrl?: string;
  durationMs: number;
  spotifyUri?: string; // set when provider === "spotify"
};

export type ScoredTrack = LibraryTrack & { score: number };

// Normalized "same song" key used to dedupe/merge a track across accounts
// and across providers (an Apple Music copy and a Spotify copy of the same
// song should collapse into one collaborative-mix entry).
export function trackMatchKey(name: string, artists: string[]): string {
  return `${normalizeForMatch(name)}|${normalizeForMatch(artists[0] ?? "")}`;
}

// Combining accents (U+0300–U+036F), removed after decomposing so "Beyoncé" matches "Beyonce".
const ACCENTS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");

// Anything that is not a letter or number in any script (built at runtime: the TS target predates the u flag).
const NON_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");

// Lower-case, accent-free (Latin accents only; other scripts are kept as-is), apostrophes dropped ("Don't" and "Dont" are one song, not "don t"),
// every other run of non-letter/number characters collapsed to a single space.
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(NON_WORD, " ")
    .trim();
}
