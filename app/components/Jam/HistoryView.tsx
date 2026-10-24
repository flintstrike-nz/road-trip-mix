"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getHistoryStore, type PlayRecord } from "@/lib/history";
import { RECORD_FLAG_KEY } from "@/lib/playback-recorder";
import "./jam.css";

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function top<T>(items: T[], key: (t: T) => string | undefined, n = 3): [string, number][] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

export default function HistoryView() {
  const [rows, setRows] = useState<PlayRecord[] | null>(null);
  const [jamOnly, setJamOnly] = useState(false);
  const [recording, setRecording] = useState(false);

  const load = useCallback(() => {
    getHistoryStore().list({ limit: 500 }).then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(() => {
    load();
    try {
      setRecording(localStorage.getItem(RECORD_FLAG_KEY) === "1");
    } catch {}
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => (rows ?? []).filter((r) => !jamOnly || r.source !== "external"), [rows, jamOnly]);
  const plays = shown.filter((r) => r.endedAt);
  const skipped = plays.filter((r) => r.skipped).length;

  const toggleRecording = (on: boolean) => {
    setRecording(on);
    try {
      localStorage.setItem(RECORD_FLAG_KEY, on ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event("rtm-record-flag"));
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(shown, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `road-trip-mix-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="jam">
      <h2 className="jam__title">Play history</h2>
      <p className="jam__subtitle">
        Every song that plays during a jam is kept on this device with its full track details, who added it, and whether
        it was played through or skipped.
      </p>

      <section className="jam__section">
        <label className="jam__radio">
          <input type="checkbox" checked={recording} onChange={(e) => toggleRecording(e.target.checked)} /> Also record
          what I play outside of jams while this app is open
        </label>
        <label className="jam__radio">
          <input type="checkbox" checked={jamOnly} onChange={(e) => setJamOnly(e.target.checked)} /> Jam plays only
        </label>
        <div className="jam__controls">
          <button className="jam__btn jam__btn--ghost" onClick={exportJson} disabled={shown.length === 0}>
            Export JSON
          </button>
          <button
            className="jam__btn jam__btn--ghost"
            disabled={shown.length === 0}
            onClick={() => {
              if (confirm("Delete all play history on this device?")) void getHistoryStore().clear().then(load);
            }}
          >
            Clear
          </button>
        </div>
      </section>

      {plays.length > 0 && (
        <section className="jam__section">
          <h3>Summary</h3>
          <p className="jam__meta">
            {plays.length} plays · {Math.round((skipped / plays.length) * 100)}% skipped
          </p>
          <p className="jam__meta">
            Top artists: {top(plays, (r) => r.track.artists[0]?.name).map(([n, c]) => `${n} (${c})`).join(", ") || "—"}
          </p>
          <p className="jam__meta">
            Most songs added: {top(plays, (r) => r.addedBy?.name).map(([n, c]) => `${n} (${c})`).join(", ") || "—"}
          </p>
        </section>
      )}

      <section className="jam__section">
        {rows === null && <p className="jam__muted">Loading…</p>}
        {rows && shown.length === 0 && <p className="jam__muted">Nothing played yet.</p>}
        {shown.map((r) => (
          <div key={r.id} className="jam__row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {r.track.album.imageUrl ? <img src={r.track.album.imageUrl} alt="" width={40} height={40} className="jam__art" /> : <div className="jam__art" />}
            <div className="jam__info">
              <p className="jam__name">{r.track.name}</p>
              <p className="jam__meta">
                {r.track.artists.map((a) => a.name).join(", ")}
                {r.addedBy && ` · added by ${r.addedBy.name}`}
                {r.jamName && ` · ${r.jamName}`}
              </p>
            </div>
            <div className="jam__meta" style={{ textAlign: "right", flex: "none" }}>
              <p>{when(r.startedAt)}</p>
              <p>{!r.endedAt ? "playing…" : r.completed ? "played" : r.skipped ? "skipped" : "partly played"}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
