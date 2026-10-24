import { getSession } from "next-auth/react";
import type { TokenSource } from "./spotify-api";

// Token source backed by the NextAuth session. Spotify tokens last an hour and
// NextAuth refreshes them server-side whenever the session is read, so we cache
// briefly (to avoid a request per poll) and re-read on a 401.
export function sessionTokenSource(maxAgeMs = 10 * 60 * 1000): TokenSource {
  let cached: { token: string; at: number } | null = null;

  const load = async (): Promise<string> => {
    const session = await getSession();
    const token = session?.accessToken;
    if (!token) throw new Error("No Spotify access token — please sign out and back in.");
    cached = { token, at: Date.now() };
    return token;
  };

  return {
    get: async () => (cached && Date.now() - cached.at < maxAgeMs ? cached.token : load()),
    refresh: load,
  };
}
