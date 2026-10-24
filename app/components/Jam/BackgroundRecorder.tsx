"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { RECORD_FLAG_KEY, startBackgroundRecorder } from "@/lib/playback-recorder";
import { sessionTokenSource } from "@/lib/session-token";

// Mounted once in the page layout; records history when the user has switched
// recording on from the History page.
export default function BackgroundRecorder() {
  const { data: session } = useSession();
  const signedIn = !!session?.accessToken;

  useEffect(() => {
    if (!signedIn) return;
    let stop: (() => void) | null = null;
    const sync = () => {
      let on = false;
      try {
        on = localStorage.getItem(RECORD_FLAG_KEY) === "1";
      } catch {}
      if (on && !stop) stop = startBackgroundRecorder(sessionTokenSource());
      if (!on && stop) {
        stop();
        stop = null;
      }
    };
    sync();
    window.addEventListener("rtm-record-flag", sync);
    return () => {
      window.removeEventListener("rtm-record-flag", sync);
      stop?.();
    };
  }, [signedIn]);

  return null;
}
