import type { PublicJamState, QueueEntry } from "../../lib/jam/types";

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Reorder one entry within a member's queue; used for optimistic UI before the
// host's snapshot confirms it.
export function moveInQueue(queue: QueueEntry[], entryId: string, toIndex: number): QueueEntry[] {
  const from = queue.findIndex((e) => e.id === entryId);
  if (from < 0) return queue;
  const next = queue.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(0, toIndex), next.length), 0, item);
  return next;
}

// Snapshots can arrive out of order after a reconnect; only move forward.
export function isNewer(current: PublicJamState | null, incoming: PublicJamState): boolean {
  return !current || current.id !== incoming.id || incoming.rev >= current.rev;
}

export function parseJoinCode(location: { search: string; hash: string }): string {
  const fromQuery = new URLSearchParams(location.search).get("code");
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("code");
  return (fromQuery ?? fromHash ?? "").trim().toUpperCase().slice(0, 12);
}
