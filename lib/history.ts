import type { TrackMeta } from "./jam/types";

// Local play history. It's kept on the device running the app (IndexedDB) and
// stores a full snapshot of the track metadata at play time, so later
// features (recommendations, "you always skip this", tempo/energy arcs) can
// work from whatever was known then without extra API calls.

export type PlayRecord = {
  id: string;
  track: TrackMeta;
  startedAt: number;
  endedAt?: number;
  playedMs: number;
  completed: boolean;
  skipped: boolean;
  source: "jam" | "filler" | "external";
  jamId?: string;
  jamName?: string;
  playlistId?: string;
  addedBy?: { memberId: string; name: string };
  round?: number;
  deviceName?: string;
  listeners?: string[]; // names of members online when it started
};

export type HistoryQuery = {
  limit?: number;
  before?: number; // startedAt cursor
  jamId?: string;
  trackId?: string;
};

export interface HistoryStore {
  put(record: PlayRecord): Promise<void>;
  list(q?: HistoryQuery): Promise<PlayRecord[]>; // newest first
  count(): Promise<number>;
  clear(): Promise<void>;
}

function matches(r: PlayRecord, q: HistoryQuery): boolean {
  return (
    (q.before === undefined || r.startedAt < q.before) &&
    (q.jamId === undefined || r.jamId === q.jamId) &&
    (q.trackId === undefined || r.track.id === q.trackId)
  );
}

export class MemoryHistoryStore implements HistoryStore {
  private rows = new Map<string, PlayRecord>();
  async put(r: PlayRecord) {
    this.rows.set(r.id, structuredClone(r));
  }
  async list(q: HistoryQuery = {}) {
    return Array.from(this.rows.values())
      .filter((r) => matches(r, q))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, q.limit ?? 100);
  }
  async count() {
    return this.rows.size;
  }
  async clear() {
    this.rows.clear();
  }
}

const DB_NAME = "road-trip-mix";
const STORE = "plays";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbHistoryStore implements HistoryStore {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("startedAt", "startedAt");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbp;
  }

  private async store(mode: IDBTransactionMode) {
    return (await this.db()).transaction(STORE, mode).objectStore(STORE);
  }

  async put(r: PlayRecord) {
    await req((await this.store("readwrite")).put(r));
  }

  async list(q: HistoryQuery = {}) {
    const store = await this.store("readonly");
    const limit = q.limit ?? 100;
    const out: PlayRecord[] = [];
    const range = q.before !== undefined ? IDBKeyRange.upperBound(q.before, true) : undefined;
    await new Promise<void>((resolve, reject) => {
      const cur = store.index("startedAt").openCursor(range, "prev");
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || out.length >= limit) return resolve();
        const r = c.value as PlayRecord;
        if (matches(r, q)) out.push(r);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return out;
  }

  async count() {
    return req((await this.store("readonly")).count());
  }

  async clear() {
    await req((await this.store("readwrite")).clear());
  }
}

let shared: HistoryStore | null = null;
export function getHistoryStore(): HistoryStore {
  if (!shared) shared = typeof indexedDB !== "undefined" ? new IndexedDbHistoryStore() : new MemoryHistoryStore();
  return shared;
}

// Turns tracker events into history rows. `begin` opens a record when a track
// starts; `end` closes the previous one using the last progress we saw.
export class HistoryRecorder {
  private open: PlayRecord | null = null;

  constructor(private store: HistoryStore, private now: () => number = Date.now) {}

  async begin(info: Omit<PlayRecord, "id" | "startedAt" | "playedMs" | "completed" | "skipped">): Promise<void> {
    const startedAt = this.now();
    this.open = { ...info, id: `${startedAt}:${info.track.id}`, startedAt, playedMs: 0, completed: false, skipped: false };
    await this.store.put(this.open);
  }

  // `lastProgressMs` is the playback position when the track ended or was left.
  async end(lastProgressMs: number): Promise<void> {
    const rec = this.open;
    if (!rec) return;
    this.open = null;
    const dur = rec.track.durationMs;
    const playedMs = Math.max(0, Math.min(lastProgressMs, dur || lastProgressMs));
    const completed = dur > 0 && playedMs >= dur - 8000;
    await this.store.put({ ...rec, endedAt: this.now(), playedMs, completed, skipped: !completed && playedMs < 30000 });
  }
}
