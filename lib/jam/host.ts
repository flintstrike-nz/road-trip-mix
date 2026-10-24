import { parseClientMessage, type ClientMessage, type ErrorCode, type ServerMessage } from "./protocol";
import { buildUpcoming } from "./schedule";
import type {
  BaseEntry,
  JamSettings,
  JamState,
  Member,
  PublicJamState,
  QueueEntry,
  ScheduledItem,
  TrackMeta,
} from "./types";

// The authoritative jam session. It lives on the host device (inside the app's
// WebView or a browser tab), applies every change in order, and broadcasts a
// fresh snapshot after each one. Joiners are thin views: they send intents
// (`add`, `move`, ...) and render whatever snapshot comes back.
//
// Pure logic only: I/O (sockets, Spotify) is injected, so it can be unit
// tested without a network.

export const MEMBER_COLORS = [
  "#1db954", "#3d87e4", "#f0a500", "#e25f5f", "#a855f7", "#14b8a6", "#f97316", "#ec4899",
];

const PUBLIC_UPCOMING_LIMIT = 60;
const SEARCH_MIN_INTERVAL_MS = 400;
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export type HostDeps = {
  now: () => number;
  genId: () => string;
  search?: (query: string) => Promise<TrackMeta[]>;
  send: (clientId: string, msg: ServerMessage) => void;
  broadcast: (msg: ServerMessage) => void;
  close?: (clientId: string) => void;
  onChange?: (state: JamState) => void;
};

export type ActionResult =
  | { ok: true; entryId?: string }
  | { ok: false; code: ErrorCode; message: string };

const fail = (code: ErrorCode, message: string): ActionResult => ({ ok: false, code, message });

export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export function randomJoinCode(len = 4): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => JOIN_CODE_ALPHABET[b % JOIN_CODE_ALPHABET.length]).join("");
}

export type CreateJamOptions = {
  name: string;
  hostName: string;
  hostDeviceId?: string;
  base?: TrackMeta[];
  targetPlaylistId?: string;
  groupedPlaylistId?: string;
  settings?: Partial<JamSettings>;
};

export function createJamState(opts: CreateJamOptions, deps: Pick<HostDeps, "now" | "genId"> = { now: Date.now, genId: randomId }): JamState {
  const hostMemberId = opts.hostDeviceId ?? deps.genId();
  const host: Member = {
    id: hostMemberId,
    name: opts.hostName,
    color: MEMBER_COLORS[0],
    isHost: true,
    joinedAt: deps.now(),
    online: true,
  };
  return {
    id: deps.genId(),
    name: opts.name,
    rev: 0,
    createdAt: deps.now(),
    hostMemberId,
    settings: {
      maxQueuePerMember: 25,
      allowDuplicates: false,
      joinCode: randomJoinCode(),
      ...opts.settings,
    },
    memberOrder: [hostMemberId],
    members: { [hostMemberId]: host },
    banned: [],
    queues: { [hostMemberId]: [] },
    lastRound: { [hostMemberId]: -1 },
    cursor: null,
    nowPlaying: null,
    base: (opts.base ?? []).map((track, i): BaseEntry => ({ id: `base:${i}:${track.id}`, track })),
    playlistLocked: 0,
    targetPlaylistId: opts.targetPlaylistId,
    groupedPlaylistId: opts.groupedPlaylistId,
  };
}

export function toPublicState(state: JamState, limit = PUBLIC_UPCOMING_LIMIT): PublicJamState {
  const upcoming = buildUpcoming(state);
  return {
    id: state.id,
    name: state.name,
    rev: state.rev,
    hostMemberId: state.hostMemberId,
    settings: {
      maxQueuePerMember: state.settings.maxQueuePerMember,
      allowDuplicates: state.settings.allowDuplicates,
    },
    memberOrder: state.memberOrder,
    members: state.members,
    queues: state.queues,
    nowPlaying: state.nowPlaying,
    upcoming: upcoming.slice(0, limit),
    baseRemaining: upcoming.filter((u) => u.memberId === null).length,
  };
}

export class JamHost {
  private state: JamState;
  private clientToMember = new Map<string, string>();
  private lastSearchAt = new Map<string, number>();

  constructor(state: JamState, private deps: HostDeps) {
    // A restored session starts with everyone offline until they reconnect.
    this.state = {
      ...state,
      members: Object.fromEntries(
        Object.entries(state.members).map(([id, m]) => [id, { ...m, online: m.isHost }])
      ),
    };
  }

  getState(): JamState {
    return this.state;
  }

  publicState(): PublicJamState {
    return toPublicState(this.state);
  }

  upcoming(): ScheduledItem[] {
    return buildUpcoming(this.state);
  }

  // --- connections -------------------------------------------------------

  clientConnected(): void {
    // Nothing to do until the client says hello; kept for transport symmetry.
  }

  clientDisconnected(clientId: string): void {
    const memberId = this.clientToMember.get(clientId);
    this.clientToMember.delete(clientId);
    this.lastSearchAt.delete(clientId);
    if (!memberId) return;
    // A member can have a second live connection (tab reopened); only mark
    // offline when none are left.
    if (Array.from(this.clientToMember.values()).includes(memberId)) return;
    this.mutate((s) => {
      if (s.members[memberId]) s.members[memberId] = { ...s.members[memberId], online: false };
    });
  }

  handleRaw(clientId: string, raw: string): void {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.deps.send(clientId, { t: "error", code: "bad-request", message: "Malformed message." });
      return;
    }
    this.handle(clientId, msg);
  }

  private reply(clientId: string, result: ActionResult) {
    if (!result.ok) this.deps.send(clientId, { t: "error", code: result.code, message: result.message });
  }

  private handle(clientId: string, msg: ClientMessage): void {
    if (msg.t === "hello") {
      this.reply(clientId, this.join(clientId, msg.deviceId, msg.name, msg.code));
      return;
    }
    const memberId = this.clientToMember.get(clientId);
    if (!memberId) {
      this.deps.send(clientId, { t: "error", code: "not-joined", message: "Join the session first." });
      return;
    }
    switch (msg.t) {
      case "add":
        this.reply(clientId, this.addTrack(memberId, msg.track, msg.index));
        break;
      case "remove":
        this.reply(clientId, this.removeEntry(memberId, msg.entryId));
        break;
      case "move":
        this.reply(clientId, this.moveEntry(memberId, msg.entryId, msg.toIndex));
        break;
      case "rename":
        this.reply(clientId, this.rename(memberId, msg.name));
        break;
      case "search":
        void this.runSearch(clientId, msg.reqId, msg.q);
        break;
    }
  }

  private join(clientId: string, deviceId: string, name: string, code: string): ActionResult {
    if (code.toUpperCase() !== this.state.settings.joinCode) {
      return fail("bad-code", "That join code isn't right.");
    }
    if (this.state.banned.includes(deviceId)) {
      return fail("banned", "You've been removed from this session.");
    }
    const existing = this.state.members[deviceId];
    this.clientToMember.set(clientId, deviceId);
    this.mutate((s) => {
      if (existing) {
        s.members[deviceId] = { ...existing, name: this.uniqueName(name, deviceId), online: true };
        return;
      }
      s.members[deviceId] = {
        id: deviceId,
        name: this.uniqueName(name, deviceId),
        color: MEMBER_COLORS[s.memberOrder.length % MEMBER_COLORS.length],
        isHost: false,
        joinedAt: this.deps.now(),
        online: true,
      };
      s.memberOrder = [...s.memberOrder, deviceId];
      s.queues[deviceId] = [];
      s.lastRound[deviceId] = -1;
    }, false);
    this.deps.send(clientId, { t: "welcome", memberId: deviceId, state: this.publicState() });
    this.emit();
    return { ok: true };
  }

  private uniqueName(name: string, selfId: string): string {
    const taken = new Set(
      Object.values(this.state.members).filter((m) => m.id !== selfId).map((m) => m.name.toLowerCase())
    );
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // --- queue actions (shared by joiners and the host's own UI) -----------

  addTrack(memberId: string, track: TrackMeta, index?: number): ActionResult {
    const s = this.state;
    if (!s.members[memberId]) return fail("not-joined", "Join the session first.");
    const queue = s.queues[memberId] ?? [];
    if (queue.length >= s.settings.maxQueuePerMember) {
      return fail("queue-full", `Your queue is full (${s.settings.maxQueuePerMember} songs).`);
    }
    if (!s.settings.allowDuplicates) {
      const dupe = Object.values(s.queues).flat().find((e) => e.track.id === track.id);
      if (dupe) {
        const who = s.members[dupe.memberId]?.name ?? "someone";
        return fail("duplicate", `Already queued by ${who}.`);
      }
    }
    const entry: QueueEntry = { id: this.deps.genId(), memberId, track, addedAt: this.deps.now() };
    this.mutate((st) => {
      const q = [...(st.queues[memberId] ?? [])];
      const at = index === undefined ? q.length : Math.min(index, q.length);
      q.splice(at, 0, entry);
      st.queues[memberId] = q;
    });
    return { ok: true, entryId: entry.id };
  }

  private findEntry(entryId: string): QueueEntry | undefined {
    return Object.values(this.state.queues).flat().find((e) => e.id === entryId);
  }

  private canEdit(actorId: string, entry: QueueEntry): boolean {
    return entry.memberId === actorId || actorId === this.state.hostMemberId;
  }

  removeEntry(actorId: string, entryId: string): ActionResult {
    const entry = this.findEntry(entryId);
    if (!entry) return fail("not-found", "That song is no longer queued.");
    if (!this.canEdit(actorId, entry)) return fail("forbidden", "You can only edit your own queue.");
    this.mutate((st) => {
      st.queues[entry.memberId] = st.queues[entry.memberId].filter((e) => e.id !== entryId);
    });
    return { ok: true };
  }

  moveEntry(actorId: string, entryId: string, toIndex: number): ActionResult {
    const entry = this.findEntry(entryId);
    if (!entry) return fail("not-found", "That song is no longer queued.");
    if (!this.canEdit(actorId, entry)) return fail("forbidden", "You can only edit your own queue.");
    this.mutate((st) => {
      const q = st.queues[entry.memberId].filter((e) => e.id !== entryId);
      q.splice(Math.min(toIndex, q.length), 0, entry);
      st.queues[entry.memberId] = q;
    });
    return { ok: true };
  }

  rename(memberId: string, name: string): ActionResult {
    if (!this.state.members[memberId]) return fail("not-joined", "Join the session first.");
    this.mutate((st) => {
      st.members[memberId] = { ...st.members[memberId], name: this.uniqueName(name, memberId) };
    });
    return { ok: true };
  }

  // --- host-only controls ------------------------------------------------

  reorderMembers(actorId: string, order: string[]): ActionResult {
    if (actorId !== this.state.hostMemberId) return fail("forbidden", "Only the host can change the rotation.");
    const current = this.state.memberOrder;
    const valid = order.length === current.length && new Set(order).size === current.length && order.every((id) => current.includes(id));
    if (!valid) return fail("bad-request", "Rotation must list every member exactly once.");
    this.mutate((st) => {
      // Keep the cursor pointing at the same member after the shuffle.
      const playingMember = st.cursor ? st.memberOrder[st.cursor.turn] : undefined;
      st.memberOrder = order;
      if (st.cursor && playingMember) st.cursor = { ...st.cursor, turn: Math.max(0, order.indexOf(playingMember)) };
    });
    return { ok: true };
  }

  kick(actorId: string, memberId: string): ActionResult {
    const s = this.state;
    if (actorId !== s.hostMemberId) return fail("forbidden", "Only the host can remove people.");
    if (memberId === s.hostMemberId || !s.members[memberId]) return fail("bad-request", "Can't remove that member.");
    for (const [clientId, m] of Array.from(this.clientToMember.entries())) {
      if (m !== memberId) continue;
      this.deps.send(clientId, { t: "kicked" });
      this.deps.close?.(clientId);
      this.clientToMember.delete(clientId);
    }
    this.mutate((st) => {
      st.banned = [...st.banned, memberId];
      delete st.members[memberId];
      delete st.queues[memberId];
      delete st.lastRound[memberId];
      const playingMember = st.cursor ? st.memberOrder[st.cursor.turn] : undefined;
      st.memberOrder = st.memberOrder.filter((id) => id !== memberId);
      if (st.cursor) {
        const turn = playingMember ? st.memberOrder.indexOf(playingMember) : -1;
        // If the member who just played is the one removed, step back so the next in line is still next.
        st.cursor = { ...st.cursor, turn: turn >= 0 ? turn : Math.max(0, Math.min(st.cursor.turn, st.memberOrder.length) - 1) };
      }
    });
    return { ok: true };
  }

  setSettings(actorId: string, patch: Partial<Pick<JamSettings, "maxQueuePerMember" | "allowDuplicates">>): ActionResult {
    if (actorId !== this.state.hostMemberId) return fail("forbidden", "Only the host can change settings.");
    this.mutate((st) => {
      st.settings = { ...st.settings, ...patch };
    });
    return { ok: true };
  }

  // Quiet bookkeeping for playlist sync: no broadcast, joiners don't care.
  setPlaylistLocked(n: number): void {
    if (n === this.state.playlistLocked) return;
    this.mutate((st) => {
      st.playlistLocked = n;
    }, false);
    this.deps.onChange?.(this.state);
  }

  // Replace the filler list, e.g. after regenerating the grouped playlist.
  setBase(tracks: TrackMeta[]): void {
    this.mutate((st) => {
      st.base = tracks.map((track, i): BaseEntry => ({ id: `base:${i}:${track.id}`, track }));
    });
  }

  // --- playback ------------------------------------------------------------

  // Called whenever the player moves to a new track. Locks that song in at the
  // matching spot of the rotation so the next round starts from there.
  trackStarted(track: TrackMeta): ScheduledItem {
    const s = this.state;
    if (s.nowPlaying && s.nowPlaying.track.id === track.id) return s.nowPlaying;

    const upcoming = buildUpcoming(s);
    const item = upcoming.find((u) => u.track.id === track.id);
    const playing: ScheduledItem = item ?? { entryId: `ext:${track.id}:${this.deps.now()}`, track, memberId: null, round: null };

    this.mutate((st) => {
      if (item?.memberId) {
        st.queues[item.memberId] = st.queues[item.memberId].filter((e) => e.id !== item.entryId);
        st.lastRound[item.memberId] = item.round ?? st.lastRound[item.memberId];
        st.cursor = { round: item.round ?? 0, turn: Math.max(0, st.memberOrder.indexOf(item.memberId)) };
      } else if (item) {
        st.base = st.base.filter((b) => b.id !== item.entryId);
      }
      st.nowPlaying = playing;
    });
    return playing;
  }

  // --- search --------------------------------------------------------------

  private async runSearch(clientId: string, reqId: string, q: string): Promise<void> {
    const now = this.deps.now();
    const last = this.lastSearchAt.get(clientId) ?? 0;
    if (now - last < SEARCH_MIN_INTERVAL_MS) {
      this.deps.send(clientId, { t: "search-result", reqId, tracks: [], error: "Searching too fast." });
      return;
    }
    this.lastSearchAt.set(clientId, now);
    if (!this.deps.search) {
      this.deps.send(clientId, { t: "search-result", reqId, tracks: [], error: "Search isn't available on the host." });
      return;
    }
    try {
      const tracks = await this.deps.search(q);
      this.deps.send(clientId, { t: "search-result", reqId, tracks });
    } catch (e) {
      this.deps.send(clientId, {
        t: "search-result",
        reqId,
        tracks: [],
        error: e instanceof Error ? e.message : "Search failed.",
      });
    }
  }

  // --- internals -----------------------------------------------------------

  private mutate(fn: (draft: JamState) => void, emit = true): void {
    // Shallow-clone the containers `fn` may touch so snapshots handed to
    // React/persistence are never mutated afterwards.
    const draft: JamState = {
      ...this.state,
      members: { ...this.state.members },
      queues: { ...this.state.queues },
      lastRound: { ...this.state.lastRound },
    };
    fn(draft);
    draft.rev = this.state.rev + 1;
    this.state = draft;
    if (emit) this.emit();
  }

  private emit(): void {
    this.deps.onChange?.(this.state);
    this.deps.broadcast({ t: "state", state: this.publicState() });
  }
}
