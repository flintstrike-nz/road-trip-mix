"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { getHistoryStore } from "@/lib/history";
import { JamController } from "@/lib/jam/controller";
import { CapacitorHostTransport, SpotifyRemote, isNativeApp, nativePlayer } from "@/lib/jam/native";
import { player, searchTracks } from "@/lib/jam/spotify-backend";
import { loadJam, saveJam } from "@/lib/jam/storage";
import { WebSocketHostTransport, type HostTransport, type TransportInfo } from "@/lib/jam/transport";
import type { JamState, QueueEntry, TrackMeta } from "@/lib/jam/types";
import { setJamActive } from "@/lib/playback-recorder";
import { sessionTokenSource } from "@/lib/session-token";
import JoinPanel from "./JoinPanel";
import { loadTransportPrefs } from "./JamHome";
import WebPlayer from "./WebPlayer";
import "./jam.css";

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000) % 60).padStart(2, "0")}`;

function Art({ track }: { track: TrackMeta }) {
  // eslint-disable-next-line @next/next/no-img-element
  return track.album.imageUrl ? <img src={track.album.imageUrl} alt="" width={40} height={40} className="jam__art" /> : <div className="jam__art" />;
}

export default function JamConsole({ id }: { id: string }) {
  const { data: session } = useSession();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [initial, setInitial] = useState<JamState | null | undefined>(undefined);
  const [info, setInfo] = useState<TransportInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showJoin, setShowJoin] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrackMeta[]>([]);
  const [searching, setSearching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [remoteState, setRemoteState] = useState<"idle" | "connecting" | "connected">("idle");
  const controllerRef = useRef<JamController | null>(null);
  const tokens = useMemo(() => sessionTokenSource(), []);
  const authed = !!session?.accessToken;

  useEffect(() => setInitial(loadJam(id)), [id]);

  useEffect(() => {
    if (!initial || !authed) return;
    const prefs = loadTransportPrefs();
    const native = isNativeApp();
    const transport: HostTransport = native
      ? new CapacitorHostTransport({ hotspot: prefs.hotspot })
      : new WebSocketHostTransport(prefs.relayUrl);
    const controller = new JamController({
      state: initial,
      transport,
      tokens,
      history: getHistoryStore(),
      onPersist: saveJam,
      onUpdate: bump,
      nativePlayer: native ? nativePlayer : undefined,
    });
    controllerRef.current = controller;
    setJamActive(true);
    let cancelled = false;
    controller
      .start()
      .then((i) => !cancelled && setInfo(i))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't start the jam."));
    return () => {
      cancelled = true;
      controllerRef.current = null;
      setJamActive(false);
      void controller.stop();
    };
  }, [initial, authed, tokens]);

  const controller = controllerRef.current;
  const state = controller?.host.getState() ?? initial ?? null;

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      searchTracks(tokens, q)
        .then(setResults)
        .catch((e) => setActionError(e instanceof Error ? e.message : "Search failed."))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [query, tokens]);

  if (initial === undefined) return null;
  if (initial === null || !state) {
    return (
      <p style={{ color: "var(--text-subdued)" }}>
        Jam not found. <Link href="/jam">Back to jam mode</Link>
      </p>
    );
  }

  const host = controller?.host;
  const me = state.hostMemberId;
  const run = (r: ReturnType<NonNullable<typeof host>["addTrack"]> | undefined) => {
    setActionError(r && !r.ok ? r.message : null);
  };
  const guard = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That didn't work.");
    }
  };

  const upcoming = host?.upcoming() ?? [];
  const online = Object.values(state.members).filter((m) => m.online).length;
  const sync = controller?.syncStatus;

  const entryPos = (e: { entryId: string; memberId: string | null }) => {
    const q: QueueEntry[] = e.memberId ? state.queues[e.memberId] ?? [] : [];
    return { q, i: q.findIndex((x) => x.id === e.entryId) };
  };

  return (
    <div className="jam">
      <div className="jam__top">
        <div>
          <h2 className="jam__title">{state.name}</h2>
          <p className="jam__subtitle">
            {online} online · {upcoming.length} up next ·{" "}
            {sync?.state === "syncing" ? (
              "updating playlist…"
            ) : sync?.state === "error" ? (
              <span className="jam__error">playlist sync failed: {sync.message}</span>
            ) : state.targetPlaylistId ? (
              <>
                playlist live
                {sync?.lastSyncedAt && ` · synced ${Math.max(0, Math.round((Date.now() - sync.lastSyncedAt) / 1000))}s ago`}
                {" · "}
                <a href={`https://open.spotify.com/playlist/${state.targetPlaylistId}`} target="_blank" rel="noopener noreferrer">
                  Open in Spotify ↗
                </a>
              </>
            ) : (
              "no playlist linked"
            )}
          </p>
        </div>
        <div className="jam__top-actions">
          <Link href="/jam" className="jam__btn jam__btn--ghost">
            Leave
          </Link>
        </div>
      </div>

      {error && <p className="jam__error">{error}</p>}
      {!authed && <p className="jam__muted">Waiting for your Spotify session…</p>}

      <section className="jam__section">
        <div className="jam__section-head">
          <h3>Invite</h3>
          <button className="jam__btn jam__btn--ghost" onClick={() => setShowJoin(!showJoin)}>
            {showJoin ? "Hide" : "Show"}
          </button>
        </div>
        {showJoin &&
          (info ? (
            <JoinPanel info={info} code={state.settings.joinCode} />
          ) : (
            <p className="jam__muted">{error ? "Not running." : "Starting the local network…"}</p>
          ))}
      </section>

      <section className="jam__section">
        <h3>Now playing</h3>
        {state.nowPlaying ? (
          <div className="jam__row">
            <Art track={state.nowPlaying.track} />
            <div className="jam__info">
              <p className="jam__name">{state.nowPlaying.track.name}</p>
              <p className="jam__meta">
                {state.nowPlaying.track.artists.map((a) => a.name).join(", ")}
                {state.nowPlaying.memberId && ` · added by ${state.members[state.nowPlaying.memberId]?.name ?? "?"}`}
              </p>
            </div>
          </div>
        ) : (
          <p className="jam__muted">Nothing yet — press play to start the playlist, or play it from Spotify.</p>
        )}
        <div className="jam__controls">
          {state.targetPlaylistId && (
            <button
              className="jam__btn"
              onClick={() => guard(() => player.playPlaylist(tokens, state.targetPlaylistId!, Math.max(0, state.playlistLocked)))}
            >
              ▶ Play playlist
            </button>
          )}
          <button className="jam__btn jam__btn--ghost" onClick={() => guard(() => player.pause(tokens))}>
            Pause
          </button>
          <button className="jam__btn jam__btn--ghost" onClick={() => guard(() => player.resume(tokens))}>
            Resume
          </button>
          <button className="jam__btn jam__btn--ghost" onClick={() => guard(() => player.next(tokens))}>
            Skip ⏭
          </button>
          {isNativeApp() && process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID && (
            <button
              className="jam__btn jam__btn--ghost"
              disabled={remoteState !== "idle"}
              onClick={() =>
                guard(async () => {
                  setRemoteState("connecting");
                  try {
                    await SpotifyRemote.connect({
                      clientId: process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID!,
                      redirectUri: "roadtripmix://spotify-callback",
                    });
                    setRemoteState("connected");
                  } catch (e) {
                    setRemoteState("idle");
                    throw e;
                  }
                })
              }
            >
              {remoteState === "connected" ? "Spotify app connected ✓" : remoteState === "connecting" ? "Connecting…" : "Connect Spotify app"}
            </button>
          )}
        </div>
        {actionError && <p className="jam__error">{actionError}</p>}
        {!isNativeApp() && <WebPlayer tokens={tokens} />}
      </section>

      <div className="jam__cols">
        <section className="jam__section">
          <h3>Up next</h3>
          {upcoming.length === 0 && <p className="jam__muted">Queue is empty — add a song below, or have someone join.</p>}
          {upcoming.slice(0, 40).map((u, n) => {
            const { q, i } = entryPos(u);
            const owner = u.memberId ? state.members[u.memberId] : undefined;
            return (
              <div key={u.entryId} className="jam__row">
                <span className="jam__num">{n + 1}</span>
                <span className="jam__dot" style={{ background: owner?.color ?? "#555" }} title={owner?.name ?? "Playlist"} />
                <Art track={u.track} />
                <div className="jam__info">
                  <p className="jam__name">{u.track.name}</p>
                  <p className="jam__meta">
                    {u.track.artists.map((a) => a.name).join(", ")} · {owner?.name ?? "from the playlist"}
                  </p>
                </div>
                {u.memberId && (
                  <div className="jam__row-actions">
                    <button className="jam__icon" disabled={i <= 0} aria-label="Move earlier" onClick={() => run(host?.moveEntry(me, u.entryId, i - 1))}>
                      ▲
                    </button>
                    <button className="jam__icon" disabled={i < 0 || i >= q.length - 1} aria-label="Move later" onClick={() => run(host?.moveEntry(me, u.entryId, i + 1))}>
                      ▼
                    </button>
                    <button className="jam__icon" aria-label="Remove" onClick={() => run(host?.removeEntry(me, u.entryId))}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <section className="jam__section">
          <h3>People &amp; rotation</h3>
          {state.memberOrder.map((mid, idx) => {
            const m = state.members[mid];
            if (!m) return null;
            return (
              <div key={mid} className="jam__row">
                <span className="jam__dot" style={{ background: m.color }} />
                <div className="jam__info">
                  <p className="jam__name">
                    {m.name}
                    {m.isHost && " (you)"}
                  </p>
                  <p className="jam__meta">
                    {state.queues[mid]?.length ?? 0} queued · {m.online ? "online" : "offline"}
                  </p>
                </div>
                <div className="jam__row-actions">
                  <button
                    className="jam__icon"
                    disabled={idx === 0}
                    aria-label="Earlier in rotation"
                    onClick={() => {
                      const o = [...state.memberOrder];
                      [o[idx - 1], o[idx]] = [o[idx], o[idx - 1]];
                      run(host?.reorderMembers(me, o));
                    }}
                  >
                    ▲
                  </button>
                  <button
                    className="jam__icon"
                    disabled={idx === state.memberOrder.length - 1}
                    aria-label="Later in rotation"
                    onClick={() => {
                      const o = [...state.memberOrder];
                      [o[idx + 1], o[idx]] = [o[idx], o[idx + 1]];
                      run(host?.reorderMembers(me, o));
                    }}
                  >
                    ▼
                  </button>
                  {!m.isHost && (
                    <button
                      className="jam__icon"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => confirm(`Remove ${m.name} from the jam? They won't be able to rejoin.`) && run(host?.kick(me, mid))}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <h3 className="jam__spaced">Settings</h3>
          <label className="jam__radio">
            Songs per person in queue
            <input
              type="number"
              min={1}
              max={100}
              value={state.settings.maxQueuePerMember}
              onChange={(e) => host?.setSettings(me, { maxQueuePerMember: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
            />
          </label>
          <label className="jam__radio">
            <input
              type="checkbox"
              checked={state.settings.allowDuplicates}
              onChange={(e) => host?.setSettings(me, { allowDuplicates: e.target.checked })}
            />{" "}
            Allow the same song twice
          </label>
        </section>
      </div>

      <section className="jam__section">
        <h3>Add a song (your slot)</h3>
        <input className="jam__search" placeholder="Search songs or artists" value={query} onChange={(e) => setQuery(e.target.value)} />
        {searching && <p className="jam__muted">Searching…</p>}
        {results.map((t) => (
          <div key={t.id} className="jam__row">
            <Art track={t} />
            <div className="jam__info">
              <p className="jam__name">{t.name}</p>
              <p className="jam__meta">
                {t.artists.map((a) => a.name).join(", ")} · {fmt(t.durationMs)}
              </p>
            </div>
            <button
              className="jam__btn"
              onClick={() => {
                const r = host?.addTrack(me, t);
                run(r);
                if (r?.ok) {
                  setQuery("");
                  setResults([]);
                }
              }}
            >
              Add
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
