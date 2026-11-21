import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getFreshAccounts } from "@/lib/spotify-accounts";
import { getAccountFavorites, searchSpotifyTrack } from "@/lib/spotify-library";
import { getAppleAccounts } from "@/lib/apple-accounts";
import { getAppleAccountFavorites, searchAppleCatalogTrack, createApplePlaylist } from "@/lib/apple-music";
import { mergeFavorites, type MergedTrack } from "@/lib/collab-mix";
import { generateAiMix } from "@/lib/openrouter";
import { resolveOpenRouterKey } from "@/lib/openrouter-key";
import { uniqueSongs, uniqueUris } from "@/lib/dedupe";

type RequestBody = {
  accountIds?: string[]; // "primary" | spotify account id | `apple:<id>`
  perAccount?: number;
  useAi?: boolean;
  vibe?: string;
  targetCount?: number;
  createPlaylist?: boolean;
  playlistName?: string;
  destination?: "spotify" | "apple";
  appleAccountId?: string; // which connected Apple account owns the created playlist
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  }

  const body: RequestBody = await req.json().catch(() => ({}));
  const perAccount = body.perAccount ?? 15;
  const targetCount = body.targetCount ?? 20;
  const destination = body.destination ?? "spotify";

  const connectedSpotify = await getFreshAccounts();
  const connectedApple = getAppleAccounts();

  const wantedIds = body.accountIds?.length ? new Set(body.accountIds) : null;
  const includePrimary = !wantedIds || wantedIds.has("primary");
  const selectedSpotify = wantedIds
    ? connectedSpotify.filter((a) => wantedIds.has(a.id))
    : connectedSpotify;
  const selectedApple = wantedIds
    ? connectedApple.filter((a) => wantedIds.has(`apple:${a.id}`))
    : connectedApple;

  if (selectedSpotify.length === 0 && selectedApple.length === 0 && !includePrimary) {
    return NextResponse.json(
      { error: "No accounts selected. Pick at least one connected account to build a mix from." },
      { status: 400 }
    );
  }

  const accountFavorites = await Promise.all([
    ...(includePrimary
      ? [
          (async () => ({
            accountId: "primary",
            label: session.user?.name ?? "You",
            tracks: await getAccountFavorites(session.accessToken!),
          }))(),
        ]
      : []),
    ...selectedSpotify.map(async (account) => ({
      accountId: account.id,
      label: account.displayName,
      tracks: await getAccountFavorites(account.accessToken),
    })),
    ...selectedApple.map(async (account) => ({
      accountId: `apple:${account.id}`,
      label: `${account.label} (Apple Music)`,
      tracks: await getAppleAccountFavorites(account.musicUserToken),
    })),
  ]);

  const merged = mergeFavorites(accountFavorites, perAccount);

  let finalTracks: MergedTrack[];
  let aiTitle: string | undefined;
  let aiNote: string | undefined;

  if (body.useAi) {
    try {
      const aiResult = await generateAiMix(
        merged.map((t) => ({
          id: t.id,
          name: t.name,
          artists: t.artists.join(", "),
          fromAccounts: t.fromAccounts,
        })),
        body.vibe ?? "",
        targetCount,
        undefined,
        resolveOpenRouterKey()
      );
      const byId = new Map(merged.map((t) => [t.id, t]));
      const ordered = aiResult.trackIds.map((id) => byId.get(id)).filter((t): t is MergedTrack => !!t);
      finalTracks = ordered.length > 0 ? ordered : merged.slice(0, targetCount);
      aiTitle = aiResult.title;
      aiNote = aiResult.note;
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "AI mix generation failed" },
        { status: 502 }
      );
    }
  } else {
    finalTracks = merged.slice(0, targetCount);
  }

  // Whatever produced the list (merge or AI), a song appears once.
  finalTracks = uniqueSongs(finalTracks);

  if (!body.createPlaylist) {
    return NextResponse.json({
      tracks: finalTracks,
      suggestedName: aiTitle,
      aiNote,
      accounts: accountFavorites.map((a) => ({ id: a.accountId, displayName: a.label })),
    });
  }

  const playlistName =
    body.playlistName?.trim() ||
    aiTitle ||
    `Road Trip Mix — ${new Date().toLocaleDateString()}`;
  const description = `Collaborative mix from ${accountFavorites.map((a) => a.label).join(", ")}`;

  if (destination === "apple") {
    const appleAccount = body.appleAccountId
      ? connectedApple.find((a) => a.id === body.appleAccountId)
      : connectedApple[0];
    if (!appleAccount) {
      return NextResponse.json(
        { error: "Connect an Apple Music account in Settings before creating a playlist there." },
        { status: 400 }
      );
    }

    const catalogIds = await Promise.all(
      finalTracks.map(async (t) => t.appleId ?? (await searchAppleCatalogTrack(t.name, t.artists[0] ?? "")))
    );
    const resolvedIds = Array.from(new Set(catalogIds.filter((id): id is string => !!id)));

    let playlist;
    try {
      playlist = await createApplePlaylist(appleAccount.musicUserToken, playlistName, description, resolvedIds);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Failed to create Apple Music playlist" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      tracks: finalTracks,
      playlist: { id: playlist.id, name: playlistName },
      aiNote,
      unresolvedCount: finalTracks.length - resolvedIds.length,
    });
  }

  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok) {
    return NextResponse.json({ error: "Could not resolve your Spotify profile" }, { status: 502 });
  }

  // Two different entries can resolve to the same Spotify track (e.g. via search), so dedupe the URIs too.
  const uris = uniqueUris(
    (
      await Promise.all(
        finalTracks.map(async (t) => t.spotifyUri ?? (await searchSpotifyTrack(session.accessToken!, t.name, t.artists[0] ?? "")))
      )
    ).filter((u): u is string => !!u)
  );

  const createRes = await fetch(`https://api.spotify.com/v1/users/${me.id}/playlists`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: playlistName, description, public: false }),
  });
  const playlist = await createRes.json();
  if (!createRes.ok) {
    return NextResponse.json({ error: "Failed to create playlist" }, { status: 502 });
  }

  const chunks = [];
  for (let i = 0; i < uris.length; i += 100) chunks.push(uris.slice(i, i + 100));

  for (const chunk of chunks) {
    await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: chunk }),
    });
  }

  return NextResponse.json({
    tracks: finalTracks,
    playlist: { id: playlist.id, url: playlist.external_urls?.spotify, name: playlistName },
    aiNote,
    unresolvedCount: finalTracks.length - uris.length,
  });
}
