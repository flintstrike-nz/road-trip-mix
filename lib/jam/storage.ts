import type { JamState } from "./types";

// Jam sessions are kept in this device's localStorage (like grouped playlists)
// so the host can close the app and resume, queues intact.

const KEY = "road-trip-mix:jams";
const MAX_SESSIONS = 20;

export function loadJams(): JamState[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadJam(id: string): JamState | null {
  return loadJams().find((j) => j.id === id) ?? null;
}

export function saveJam(state: JamState): void {
  const others = loadJams().filter((j) => j.id !== state.id);
  const next = [state, ...others].slice(0, MAX_SESSIONS);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the live session still works, it just won't resume.
  }
}

export function deleteJam(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadJams().filter((j) => j.id !== id)));
  } catch {}
}
