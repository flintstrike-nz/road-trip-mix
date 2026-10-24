// Minimal browser-side Spotify Web API helper: bearer auth with a single
// refresh-and-retry on 401, and a typed error for rate limits.

export type TokenSource = {
  get: () => Promise<string>;
  // Called after a 401 to obtain a fresh token (e.g. by re-fetching the NextAuth session).
  refresh?: () => Promise<string>;
};

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterSec?: number
  ) {
    super(message);
  }
}

const API = "https://api.spotify.com/v1";

export async function spotifyFetch(
  tokens: TokenSource,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const run = async (token: string) =>
    fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    });

  let res = await run(await tokens.get());
  if (res.status === 401 && tokens.refresh) res = await run(await tokens.refresh());
  if (res.ok || res.status === 204) return res;

  const body = await res.json().catch(() => ({}));
  const message = body?.error?.message ?? res.statusText ?? `Spotify error ${res.status}`;
  const retry = res.status === 429 ? parseInt(res.headers.get("Retry-After") ?? "5", 10) : undefined;
  throw new SpotifyApiError(`Spotify ${res.status}: ${message}`, res.status, retry);
}
