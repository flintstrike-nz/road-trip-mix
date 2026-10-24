import { spotifyFetch, type TokenSource } from "./spotify-api";

// Live playlist updates that don't disturb what's playing.
//
// Spotify's playlist API can only remove items by URI (all occurrences) and
// replace at most 100 items per call, so instead of rewriting the whole
// playlist we keep everything up to and including the playing track untouched
// ("locked"), keep as much of the upcoming list as already matches, and rewrite
// only the tail from the first difference.

export type SyncPlan =
  | { kind: "noop" }
  | { kind: "tail"; keep: number; remove: string[]; add: string[] }
  | { kind: "replace"; uris: string[] };

export function planTailSync(current: string[], upcoming: string[], locked: number): SyncPlan {
  const lockedCount = Math.min(Math.max(0, locked), current.length);
  const desired = [...current.slice(0, lockedCount), ...upcoming];

  let keep = lockedCount;
  while (keep < current.length && keep < desired.length && current[keep] === desired[keep]) keep++;
  if (keep === current.length && keep === desired.length) return { kind: "noop" };

  const remove = current.slice(keep);
  const add = desired.slice(keep);

  // Removal is by URI, so it is only exact when every URI being removed occurs
  // exactly once in the playlist (and isn't a local file we can't address).
  const counts = new Map<string, number>();
  for (const u of current) counts.set(u, (counts.get(u) ?? 0) + 1);
  const exact = remove.every((u) => !u.startsWith("local:") && counts.get(u) === 1);
  if (!exact) return { kind: "replace", uris: desired };

  return { kind: "tail", keep, remove, add };
}

// Index just past the playing track, so everything before it is locked.
// `from` skips earlier occurrences when the same song appears twice.
export function lockedCount(current: string[], playingUri: string | null | undefined, from = 0): number {
  if (!playingUri) return 0;
  const i = current.findIndex((u, idx) => idx >= from && u === playingUri);
  return i >= 0 ? i + 1 : 0;
}

export async function getPlaylistUris(tokens: TokenSource, playlistId: string): Promise<{ uris: string[]; snapshotId?: string }> {
  const uris: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const res = await spotifyFetch(
      tokens,
      `/playlists/${playlistId}/items?limit=100&offset=${offset}&fields=total,items(item(uri))`
    );
    const data = await res.json();
    const items: { item: { uri?: string } | null }[] = data.items ?? [];
    items.forEach((it, i) => uris.push(it.item?.uri ?? `local:${offset + i}`));
    if (offset + 100 >= (data.total ?? 0) || items.length === 0) break;
  }
  const meta = await spotifyFetch(tokens, `/playlists/${playlistId}?fields=snapshot_id`);
  const snapshotId: string | undefined = (await meta.json()).snapshot_id;
  return { uris, snapshotId };
}

const chunk = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function applySyncPlan(
  tokens: TokenSource,
  playlistId: string,
  plan: SyncPlan,
  snapshotId?: string
): Promise<void> {
  if (plan.kind === "noop") return;

  if (plan.kind === "replace") {
    const [first, ...rest] = chunk(plan.uris, 100);
    await spotifyFetch(tokens, `/playlists/${playlistId}/items`, {
      method: "PUT",
      body: JSON.stringify({ uris: first ?? [] }),
    });
    for (const c of rest) {
      await spotifyFetch(tokens, `/playlists/${playlistId}/items`, { method: "POST", body: JSON.stringify({ uris: c }) });
    }
    return;
  }

  let snap = snapshotId;
  for (const c of chunk(plan.remove, 100)) {
    const res = await spotifyFetch(tokens, `/playlists/${playlistId}/items`, {
      method: "DELETE",
      body: JSON.stringify({ items: c.map((uri) => ({ uri })), ...(snap ? { snapshot_id: snap } : {}) }),
    });
    snap = (await res.json().catch(() => ({}))).snapshot_id ?? snap;
  }
  for (const c of chunk(plan.add, 100)) {
    await spotifyFetch(tokens, `/playlists/${playlistId}/items`, { method: "POST", body: JSON.stringify({ uris: c }) });
  }
}

// One-call convenience: read the playlist, plan, apply.
// `lock` is either the URI of the track playing from this playlist (everything
// through it is left alone; null rewrites the whole playlist) or a function
// that decides how many leading items are off limits.
export async function syncPlaylistLive(
  tokens: TokenSource,
  playlistId: string,
  upcomingUris: string[],
  lock: string | null | ((current: string[]) => number)
): Promise<SyncPlan> {
  const { uris, snapshotId } = await getPlaylistUris(tokens, playlistId);
  const locked = typeof lock === "function" ? lock(uris) : lockedCount(uris, lock);
  const plan = planTailSync(uris, upcomingUris, locked);
  await applySyncPlan(tokens, playlistId, plan, snapshotId);
  return plan;
}

// For a regenerated list (e.g. a grouped playlist's rules re-run): everything
// through the playing track stays put, and the rest of the playlist becomes the
// generated tracks that haven't already been played.
export async function syncGeneratedLive(
  tokens: TokenSource,
  playlistId: string,
  generatedUris: string[],
  playingUri: string | null
): Promise<SyncPlan> {
  const { uris, snapshotId } = await getPlaylistUris(tokens, playlistId);
  const locked = lockedCount(uris, playingUri);
  const played = new Set(uris.slice(0, locked));
  const plan = planTailSync(uris, generatedUris.filter((u) => !played.has(u)), locked);
  await applySyncPlan(tokens, playlistId, plan, snapshotId);
  return plan;
}
