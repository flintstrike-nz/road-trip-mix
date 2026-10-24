import { parseClientMessage, type ClientMessage, type ErrorCode, type SearchKind, type ServerMessage } from "./protocol";
import { checkAdd, playedEntry, type SkipReason } from "./rules";
import { buildUpcoming } from "./schedule";
import type {
  BaseEntry,
  CollectionMeta,
  JamSettings,
  JamState,
  LimitRule,
  Member,
  PublicJamState,
  QueueEntry,
  RuleSettings,
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
const COLLECTION_MIN_INTERVAL_MS = 1500;
const MAX_COLLECTION_TRACKS = 100;
const MAX_PLAYED_LOG = 2000;
const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export type SearchResults = { tracks: TrackMeta[]; collections: CollectionMeta[] };

export type HostDeps = {
  now: () => number;
  genId: () => string;
  random?: () => number; // injectable for tests; defaults to Math.random
  search?: (query: string, kind: SearchKind) => Promise<SearchResults>;
  // Resolves an album or playlist to its tracks (at most `max`).
  loadCollection?: (kind: "album" | "playlist", id: string, max: number) => Promise<TrackMeta[]>;
  send: (clientId: string, msg: ServerMessage) => void;
  broadcast: (msg: ServerMessage) => void;
  close?: (clientId: string) => void;
  onChange?: (state: JamState) => void;
};

export type ActionResult =
  | { ok: true; entryId?: string }
  | { ok: false; code: ErrorCode; message: string };

export type AddSummary = { added: number; skipped: { reason: SkipReason; count: number }[] };

const RULE_CODE: Record<SkipReason, ErrorCode> = {
  repeat: "rule-repeat",
  duplicate: "duplicate",
  artist: "rule-artist",
  album: "rule-album",
  full: "queue-full",
};

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
  hostMemberId?: string;
  base?: TrackMeta[];
  targetPlaylistId?: string;
  groupedPlaylistId?: string;
  settings?: Partial<JamSettings>;
};

export function createJamState(opts: CreateJamOptions, deps: Pick<HostDeps, "now" | "genId"> = { now: Date.now, genId: randomId }): JamState {
  const hostMemberId = opts.hostMemberId ?? deps.genId();
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
      noRepeats: false,
      maxPerArtist: { limit: null, scope: "session" },
      maxPerAlbum: { limit: null, scope: "session" },
      joinCode: randomJoinCode(),
      ...opts.settings,
    },
    memberOrder: [hostMemberId],
    members: { [hostMemberId]: host },
    devices: {},
    banned: [],
    played: [],
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
      noRepeats: state.settings.noRepeats,
      maxPerArtist: state.settings.maxPerArtist,
      maxPerAlbum: state.settings.maxPerAlbum,
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
  private lastCollectionAt = new Map<string, number>();

  constructor(state: JamState, private deps: HostDeps) {
    // A restored session starts with everyone offline until they reconnect.
    this.state = {
      ...state,
      devices: state.devices ?? {},
      played: state.played ?? [],
      settings: {
        ...state.settings,
        noRepeats: state.settings.noRepeats ?? false,
        maxPerArtist: state.settings.maxPerArtist ?? { limit: null, scope: "session" },
        maxPerAlbum: state.settings.maxPerAlbum ?? { limit: null, scope: "session" },
      },
      banned: state.banned ?? [],
      playlistLocked: state.playlistLocked ?? 0,
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
    this.lastCollectionAt.delete(clientId);
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
        void this.runSearch(clientId, msg.reqId, msg.q, msg.kind);
        break;
      case "add-collection":
        void this.runAddCollection(clientId, memberId, msg);
        break;
      case "clear":
        this.reply(clientId, this.clearQueue(memberId, memberId));
        break;
      case "shuffle":
        this.reply(clientId, this.shuffleQueue(memberId, memberId));
        break;
    }
  }

  private join(clientId: string, deviceToken: string, name: string, code: string): ActionResult {
    if (code.toUpperCase() !== this.state.settings.joinCode) {
      return fail("bad-code", "That join code isn't right.");
    }
    if (this.state.banned.includes(deviceToken)) {
      return fail("banned", "You've been removed from this session.");
    }
    // The device token is the credential; the member id it maps to is public.
    let memberId = this.state.devices[deviceToken];
    if (memberId && !this.state.members[memberId]) memberId = ""; // stale mapping
    const existing = memberId ? this.state.members[memberId] : undefined;
    if (!memberId) memberId = this.deps.genId();
    const id = memberId;

    this.clientToMember.set(clientId, id);
    this.mutate((s) => {
      s.devices = { ...s.devices, [deviceToken]: id };
      if (existing) {
        s.members[id] = { ...existing, name: this.uniqueName(name, id), online: true };
        return;
      }
      s.members[id] = {
        id,
        name: this.uniqueName(name, id),
        color: MEMBER_COLORS[s.memberOrder.length % MEMBER_COLORS.length],
        isHost: false,
        joinedAt: this.deps.now(),
        online: true,
      };
      s.memberOrder = [...s.memberOrder, id];
      s.queues[id] = [];
      s.lastRound[id] = -1;
    }, false);
    this.deps.send(clientId, { t: "welcome", memberId: id, state: this.publicState() });
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
    if ((s.queues[memberId] ?? []).length >= s.settings.maxQueuePerMember) {
      return fail("queue-full", `Your queue is full (${s.settings.maxQueuePerMember} songs).`);
    }
    const rule = checkAdd(s, track);
    if (!rule.ok) return fail(RULE_CODE[rule.reason], rule.message);

    const entry: QueueEntry = { id: this.deps.genId(), memberId, track, addedAt: this.deps.now() };
    this.mutate((st) => {
      const q = [...(st.queues[memberId] ?? [])];
      const at = index === undefined ? q.length : Math.min(index, q.length);
      q.splice(at, 0, entry);
      st.queues[memberId] = q;
    });
    return { ok: true, entryId: entry.id };
  }

  // Adds as many of `tracks` as the rules and the queue limit allow, in order,
  // in a single update. Each track is checked against the ones accepted before
  // it, so e.g. a per-artist limit applies within the batch too.
  addMany(memberId: string, tracks: TrackMeta[]): AddSummary | { error: ActionResult & { ok: false } } {
    if (!this.state.members[memberId]) return { error: fail("not-joined", "Join the session first.") as ActionResult & { ok: false } };
    const accepted: QueueEntry[] = [];
    const skipped = new Map<SkipReason, number>();
    const skip = (r: SkipReason) => skipped.set(r, (skipped.get(r) ?? 0) + 1);

    let view = this.state;
    for (const track of tracks) {
      if ((view.queues[memberId] ?? []).length >= view.settings.maxQueuePerMember) {
        skip("full");
        continue;
      }
      const rule = checkAdd(view, track);
      if (!rule.ok) {
        skip(rule.reason);
        continue;
      }
      const entry: QueueEntry = { id: this.deps.genId(), memberId, track, addedAt: this.deps.now() };
      accepted.push(entry);
      view = { ...view, queues: { ...view.queues, [memberId]: [...(view.queues[memberId] ?? []), entry] } };
    }
    if (accepted.length > 0) {
      this.mutate((st) => {
        st.queues[memberId] = [...(st.queues[memberId] ?? []), ...accepted];
      });
    }
    return { added: accepted.length, skipped: Array.from(skipped.entries()).map(([reason, count]) => ({ reason, count })) };
  }

  clearQueue(actorId: string, memberId: string): ActionResult {
    if (!this.state.members[memberId]) return fail("not-found", "No such member.");
    if (actorId !== memberId && actorId !== this.state.hostMemberId) return fail("forbidden", "You can only edit your own queue.");
    if ((this.state.queues[memberId] ?? []).length === 0) return { ok: true };
    this.mutate((st) => {
      st.queues[memberId] = [];
    });
    return { ok: true };
  }

  shuffleQueue(actorId: string, memberId: string): ActionResult {
    if (!this.state.members[memberId]) return fail("not-found", "No such member.");
    if (actorId !== memberId && actorId !== this.state.hostMemberId) return fail("forbidden", "You can only edit your own queue.");
    const q = [...(this.state.queues[memberId] ?? [])];
    if (q.length < 2) return { ok: true };
    const rand = this.deps.random ?? Math.random;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.mutate((st) => {
      st.queues[memberId] = q;
    });
    return { ok: true };
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
      const tokens = Object.keys(st.devices).filter((t) => st.devices[t] === memberId);
      st.banned = [...st.banned, ...tokens];
      st.devices = Object.fromEntries(Object.entries(st.devices).filter(([, m]) => m !== memberId));
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

  setSettings(actorId: string, patch: Partial<RuleSettings>): ActionResult {
    if (actorId !== this.state.hostMemberId) return fail("forbidden", "Only the host can change settings.");
    const clampLimit = (r: LimitRule | undefined, current: LimitRule): LimitRule => {
      if (!r) return current;
      const limit = r.limit === null ? null : Math.max(1, Math.min(50, Math.floor(Number(r.limit)) || 1));
      return { limit, scope: r.scope === "queue" ? "queue" : "session" };
    };
    this.mutate((st) => {
      const cur = st.settings;
      st.settings = {
        ...cur,
        ...(patch.maxQueuePerMember !== undefined && { maxQueuePerMember: Math.max(1, Math.min(100, Math.floor(patch.maxQueuePerMember) || 1)) }),
        ...(patch.allowDuplicates !== undefined && { allowDuplicates: !!patch.allowDuplicates }),
        ...(patch.noRepeats !== undefined && { noRepeats: !!patch.noRepeats }),
        maxPerArtist: clampLimit(patch.maxPerArtist, cur.maxPerArtist),
        maxPerAlbum: clampLimit(patch.maxPerAlbum, cur.maxPerAlbum),
      };
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
      st.played = [...st.played, playedEntry(track, playing.memberId, this.deps.now())].slice(-MAX_PLAYED_LOG);
    });
    return playing;
  }

  // --- search --------------------------------------------------------------

  private tooFast(log: Map<string, number>, clientId: string, minMs: number): boolean {
    const now = this.deps.now();
    const last = log.get(clientId) ?? -Infinity;
    if (now - last < minMs) return true;
    log.set(clientId, now);
    return false;
  }

  private async runSearch(clientId: string, reqId: string, q: string, kind: SearchKind): Promise<void> {
    const empty = { t: "search-result" as const, reqId, kind, tracks: [], collections: [] };
    if (this.tooFast(this.lastSearchAt, clientId, SEARCH_MIN_INTERVAL_MS)) {
      this.deps.send(clientId, { ...empty, error: "Searching too fast." });
      return;
    }
    if (!this.deps.search) {
      this.deps.send(clientId, { ...empty, error: "Search isn't available on the host." });
      return;
    }
    try {
      const res = await this.deps.search(q, kind);
      this.deps.send(clientId, { ...empty, tracks: res.tracks, collections: res.collections });
    } catch (e) {
      this.deps.send(clientId, { ...empty, error: e instanceof Error ? e.message : "Search failed." });
    }
  }

  private async runAddCollection(
    clientId: string,
    memberId: string,
    msg: Extract<ClientMessage, { t: "add-collection" }>
  ): Promise<void> {
    const fail = (error: string) => this.deps.send(clientId, { t: "add-result", reqId: msg.reqId, added: 0, skipped: [], error });
    if (this.tooFast(this.lastCollectionAt, clientId, COLLECTION_MIN_INTERVAL_MS)) return fail("Slow down a moment.");
    if (!this.deps.loadCollection) return fail("Adding albums and playlists isn't available on the host.");
    try {
      const result = await this.addCollection(memberId, msg.kind, msg.id, msg.shuffle === true);
      this.deps.send(clientId, { t: "add-result", reqId: msg.reqId, ...result });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Couldn't load that.");
    }
  }

  // Expands an album or playlist into the member's queue (optionally shuffled
  // first), applying the same rules as single adds.
  async addCollection(memberId: string, kind: "album" | "playlist", id: string, shuffle = false): Promise<AddSummary> {
    if (!this.deps.loadCollection) throw new Error("Adding albums and playlists isn't available.");
    let tracks = await this.deps.loadCollection(kind, id, MAX_COLLECTION_TRACKS);
    tracks = tracks.slice(0, MAX_COLLECTION_TRACKS);
    if (shuffle) {
      const rand = this.deps.random ?? Math.random;
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
    }
    const r = this.addMany(memberId, tracks);
    if ("error" in r) throw new Error(r.error.message);
    return r;
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
      devices: { ...this.state.devices },
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
