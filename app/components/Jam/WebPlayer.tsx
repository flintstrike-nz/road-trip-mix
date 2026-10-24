"use client";

import { useEffect, useRef, useState } from "react";
import type { TokenSource } from "@/lib/spotify-api";
import { spotifyFetch } from "@/lib/spotify-api";

// Spotify Web Playback SDK: turns this browser tab into a Spotify Connect
// device ("Road Trip Mix"), so a laptop or desktop can be the car's speaker.
// Requires Premium, and Spotify doesn't support it on mobile browsers or
// Android WebView — on a phone, play through the Spotify app instead.

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

function loadSdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = SDK_SRC;
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load the Spotify player."));
    document.body.appendChild(s);
  });
}

export default function WebPlayer({ tokens }: { tokens: TokenSource }) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string>("");
  const playerRef = useRef<Spotify.Player | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        setStatus("Loading player…");
        await loadSdk();
        if (cancelled) return;
        const player = new window.Spotify.Player({
          name: "Road Trip Mix (this browser)",
          getOAuthToken: (cb) => void tokens.get().then(cb),
          volume: 0.8,
        });
        playerRef.current = player;
        player.addListener("ready", ({ device_id }) => {
          setStatus("Ready — playing here.");
          void spotifyFetch(tokens, "/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [device_id], play: false }) }).catch(() => {});
        });
        player.addListener("not_ready", () => setStatus("Player went offline."));
        player.addListener("initialization_error", ({ message }) => setStatus(`Not supported here: ${message}`));
        player.addListener("authentication_error", ({ message }) => setStatus(`Auth problem: ${message}. Sign out and back in to grant playback access.`));
        player.addListener("account_error", () => setStatus("Spotify Premium is required for in-browser playback."));
        await player.connect();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Player failed to start.");
      }
    })();
    return () => {
      cancelled = true;
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, [enabled, tokens]);

  return (
    <div className="jam__webplayer">
      <label className="jam__radio">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Play through this browser
        (Spotify Premium, desktop browsers)
      </label>
      {status && <p className="jam__hint">{status}</p>}
    </div>
  );
}
