"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { loadGroupedPlaylists, type GroupedPlaylist } from "@/lib/grouped-playlists";
import { getAllPlaylists } from "@/lib/spotify";
import { createJamState } from "@/lib/jam/host";
import { isNativeApp } from "@/lib/jam/native";
import { createPlaylist, fetchPlaylistTracks, getPlayback } from "@/lib/jam/spotify-backend";
import { deleteJam, loadJams, saveJam } from "@/lib/jam/storage";
import type { JamState } from "@/lib/jam/types";
import { sessionTokenSource } from "@/lib/session-token";
import "./jam.css";

type Source = "grouped" | "spotify" | "new";
type SpotifyPlaylist = { id: string; name: string };

export const TRANSPORT_PREFS_KEY = "road-trip-mix:jam-transport";
export type TransportPrefs = { relayUrl: string; hotspot: boolean };
export const DEFAULT_TRANSPORT: TransportPrefs = { relayUrl: "ws://localhost:8787/host", hotspot: true };

export function loadTransportPrefs(): TransportPrefs {
  try {
    return { ...DEFAULT_TRANSPORT, ...JSON.parse(localStorage.getItem(TRANSPORT_PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_TRANSPORT;
  }
}

export default function JamHome() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session } = useSession();

  const [jams, setJams] = useState<JamState[]>([]);
  const [grouped, setGrouped] = useState<GroupedPlaylist[]>([]);
  const [spotifyLists, setSpotifyLists] = useState<SpotifyPlaylist[] | null>(null);
  const [native, setNative] = useState(false);

  const [name, setName] = useState("Family road trip jam");
  const [hostName, setHostName] = useState("");
  const [source, setSource] = useState<Source>("new");
  const [groupedId, setGroupedId] = useState("");
  const [spotifyId, setSpotifyId] = useState("");
  const [prefs, setPrefs] = useState<TransportPrefs>(DEFAULT_TRANSPORT);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokens = useMemo(() => sessionTokenSource(), []);

  useEffect(() => {
    setJams(loadJams());
    const linked = loadGroupedPlaylists().filter((g) => g.spotifyPlaylistId);
    setGrouped(linked);
    setNative(isNativeApp());
    setPrefs(loadTransportPrefs());
    const pre = params.get("playlist");
    if (pre && linked.some((g) => g.id === pre)) {
      setSource("grouped");
      setGroupedId(pre);
    } else if (linked[0]) {
      setGroupedId(linked[0].id);
    }
  }, [params]);

  useEffect(() => {
    if (session?.user?.name && !hostName) setHostName(session.user.name.split(" ")[0]);
  }, [session, hostName]);

  useEffect(() => {
    if (source !== "spotify" || spotifyLists || !session?.accessToken) return;
    getAllPlaylists(session.accessToken)
      .then((l) => {
        setSpotifyLists(l.map((p) => ({ id: p.id, name: p.name })));
        if (l[0]) setSpotifyId(l[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load playlists."));
  }, [source, spotifyLists, session]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      let targetPlaylistId: string | undefined;
      let groupedPlaylistId: string | undefined;
      let base: Awaited<ReturnType<typeof fetchPlaylistTracks>> = [];
      let playlistLocked = 0;

      if (source === "new") {
        targetPlaylistId = await createPlaylist(tokens, name.trim() || "Road Trip Jam");
      } else {
        const g = grouped.find((x) => x.id === groupedId);
        targetPlaylistId = source === "grouped" ? g?.spotifyPlaylistId : spotifyId;
        groupedPlaylistId = source === "grouped" ? g?.id : undefined;
        if (!targetPlaylistId) throw new Error("Pick a playlist first.");
        const all = await fetchPlaylistTracks(tokens, targetPlaylistId);
        // If it's already playing, only what's after the current song is still "to come".
        const now = await getPlayback(tokens).catch(() => null);
        const playingHere = now?.contextUri === `spotify:playlist:${targetPlaylistId}` ? now.track?.id : undefined;
        const at = playingHere ? all.findIndex((t) => t.id === playingHere) : -1;
        base = at >= 0 ? all.slice(at + 1) : all;
        // Everything up to and including the playing song is already spoken for.
        playlistLocked = at >= 0 ? at + 1 : 0;
      }

      const state = createJamState({
        name: name.trim() || "Road Trip Jam",
        hostName: hostName.trim() || "Host",
        base,
        targetPlaylistId,
        groupedPlaylistId,
        playlistLocked,
      });
      saveJam(state);
      try {
        localStorage.setItem(TRANSPORT_PREFS_KEY, JSON.stringify(prefs));
      } catch {}
      router.push(`/jam/${state.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the jam.");
      setBusy(false);
    }
  };

  return (
    <div className="jam">
      <h2 className="jam__title">Jam mode</h2>
      <p className="jam__subtitle">
        Everyone in the car gets one song slot per round. They add songs from their own phone or tablet, reorder their
        queue live, and the Spotify playlist updates straight away — no one needs a Spotify account.
      </p>

      {jams.length > 0 && (
        <section className="jam__section">
          <h3>Resume</h3>
          {jams.map((j) => (
            <div key={j.id} className="jam__resume">
              <Link href={`/jam/${j.id}`} className="jam__resume-link">
                <strong>{j.name}</strong>
                <span>
                  {j.memberOrder.length} {j.memberOrder.length === 1 ? "person" : "people"} ·{" "}
                  {Object.values(j.queues).reduce((n, q) => n + q.length, 0)} queued
                </span>
              </Link>
              <button
                className="jam__btn jam__btn--ghost"
                onClick={() => {
                  deleteJam(j.id);
                  setJams(loadJams());
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="jam__section">
        <h3>Start a jam</h3>
        <label className="jam__field">
          Session name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label className="jam__field">
          Your name
          <input value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={30} />
        </label>

        <fieldset className="jam__field">
          <legend>Playlist to update live</legend>
          <label className="jam__radio">
            <input type="radio" checked={source === "new"} onChange={() => setSource("new")} /> New empty playlist
          </label>
          <label className="jam__radio">
            <input
              type="radio"
              checked={source === "grouped"}
              disabled={grouped.length === 0}
              onChange={() => setSource("grouped")}
            />{" "}
            A playlist made by this app{grouped.length === 0 && " (push one to Spotify first)"}
          </label>
          {source === "grouped" && (
            <select value={groupedId} onChange={(e) => setGroupedId(e.target.value)}>
              {grouped.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <label className="jam__radio">
            <input type="radio" checked={source === "spotify"} onChange={() => setSource("spotify")} /> Any of my Spotify
            playlists
          </label>
          {source === "spotify" && (
            <select value={spotifyId} onChange={(e) => setSpotifyId(e.target.value)} disabled={!spotifyLists}>
              {(spotifyLists ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {source !== "new" && (
            <p className="jam__hint">
              Songs already in the playlist keep playing after everyone&apos;s queued songs. Anything already played is
              left alone.
            </p>
          )}
        </fieldset>

        {native ? (
          <label className="jam__radio">
            <input
              type="checkbox"
              checked={prefs.hotspot}
              onChange={(e) => setPrefs({ ...prefs, hotspot: e.target.checked })}
            />{" "}
            Create a local hotspot for this jam (recommended — fast, and works with no signal between devices)
          </label>
        ) : (
          <label className="jam__field">
            Jam relay address
            <input value={prefs.relayUrl} onChange={(e) => setPrefs({ ...prefs, relayUrl: e.target.value })} />
            <span className="jam__hint">
              In a browser, run <code>npm run jam-relay</code> on this machine and connect it to the car Wi-Fi or hotspot.
              The Android app does this for you.
            </span>
          </label>
        )}

        {error && <p className="jam__error">{error}</p>}
        <button className="jam__btn" onClick={start} disabled={busy || !session?.accessToken}>
          {busy ? "Starting…" : "Start jam"}
        </button>
      </section>
    </div>
  );
}
