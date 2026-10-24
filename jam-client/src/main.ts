import type { ClientMessage, SearchKind, ServerMessage } from "../../lib/jam/protocol";
import { describeAdd, describeRules } from "../../lib/jam/rules";
import type { CollectionMeta, PublicJamState, QueueEntry, ScheduledItem, TrackMeta } from "../../lib/jam/types";
import { formatDuration, isNewer, moveInQueue, parseJoinCode } from "./model";
import { makeSortable } from "./sortable";

// Joiner UI. Served by the host device itself (so it works with no internet),
// it only ever sends intents and renders the snapshots the host broadcasts.
// All text goes through textContent, never innerHTML.

const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

const deviceId = (() => {
  let id = store.get("jam.deviceId");
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set("jam.deviceId", id);
  }
  return id;
})();

type View = "queue" | "next" | "people";
let ws: WebSocket | null = null;
let state: PublicJamState | null = null;
let myId: string | null = null;
let name = store.get("jam.name") ?? "";
let code = parseJoinCode(location) || store.get("jam.code") || "";
let status: "joining" | "online" | "offline" | "kicked" = "joining";
let notice = "";
let noticeKind: "error" | "info" = "error";
let view: View = "queue";
let dragging = false;
let pendingRender = false;
let searchUi: { fill: () => void } | null = null;
let searchResults: TrackMeta[] = [];
let searchCollections: CollectionMeta[] = [];
let searchKind: SearchKind = "track";
let addReq = 0;
let searchError = "";
let searchReq = 0;
let retry = 0;

const root = document.getElementById("app")!;
const sheetRoot = document.getElementById("sheet")!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((e: Event) => void) | undefined> = {},
  ...kids: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  status = state ? "offline" : "joining";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    if (name && code) send({ t: "hello", deviceId, name, code });
    render();
  };
  ws.onmessage = (ev) => {
    let msg: ServerMessage;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    onServer(msg);
  };
  ws.onclose = () => {
    if (status === "kicked") return;
    status = "offline";
    render();
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
  };
}

function toast(text: string, kind: "error" | "info" = "error") {
  notice = text;
  noticeKind = kind;
  setTimeout(() => { if (notice === text) { notice = ""; render(); } }, kind === "info" ? 6000 : 4000);
}

function onServer(msg: ServerMessage) {
  switch (msg.t) {
    case "welcome":
      myId = msg.memberId;
      status = "online";
      notice = "";
      store.set("jam.code", code);
      if (isNewer(state, msg.state)) state = msg.state;
      break;
    case "state":
      if (isNewer(state, msg.state)) state = msg.state;
      break;
    case "error":
      toast(msg.message);
      if (msg.code === "bad-code" || msg.code === "banned") status = "joining";
      if (msg.code === "banned") status = "kicked";
      break;
    case "search-result":
      if (msg.reqId === String(searchReq)) {
        searchResults = msg.tracks;
        searchCollections = msg.collections;
        searchError = msg.error ?? "";
        searchUi?.fill();
      }
      break;
    case "add-result":
      if (msg.reqId === String(addReq)) {
        if (msg.error) toast(msg.error);
        else toast(describeAdd(msg.added, msg.skipped), msg.added > 0 ? "info" : "error");
        searchUi && closeSearch();
      }
      break;
    case "kicked":
      status = "kicked";
      break;
  }
  render();
}

// --- components ------------------------------------------------------------

function art(track: TrackMeta): HTMLElement {
  const url = track.album.imageUrl;
  return url && url.startsWith("https://") ? h("img", { class: "art", src: url, alt: "", loading: "lazy" }) : h("div", { class: "art" });
}

function trackInfo(track: TrackMeta, extra?: string): HTMLElement {
  return h("div", { class: "info" },
    h("div", { class: "title" }, track.name),
    h("div", { class: "sub" }, track.artists.map((a) => a.name).join(", ") + (extra ? ` · ${extra}` : "")));
}

function dot(memberId: string | null): HTMLElement {
  const m = memberId ? state?.members[memberId] : undefined;
  const d = h("span", { class: "dot", title: m?.name ?? "Playlist" });
  d.style.background = m?.color ?? "#555";
  return d;
}

function joinScreen(): HTMLElement {
  const nameIn = h("input", { type: "text", placeholder: "Your name", maxlength: "30", value: name, autocomplete: "nickname" });
  const codeIn = h("input", { type: "text", placeholder: "Join code", maxlength: "12", value: code, autocapitalize: "characters", autocomplete: "off" });
  const join = () => {
    name = nameIn.value.trim();
    code = codeIn.value.trim().toUpperCase();
    if (!name || !code) { notice = "Enter your name and the join code."; render(); return; }
    store.set("jam.name", name);
    send({ t: "hello", deviceId, name, code });
  };
  return h("div", { class: "join" },
    h("h1", {}, "Join the jam 🎶"),
    h("p", { class: "muted" }, "Add songs to the family road trip playlist. Everyone gets a turn each round."),
    nameIn, codeIn,
    h("button", { class: "primary", onclick: join }, "Join"),
    notice && h("p", { class: "error" }, notice));
}

function nowPlaying(s: PublicJamState): HTMLElement {
  const np = s.nowPlaying;
  if (!np) return h("div", { class: "now muted" }, "Nothing playing yet — hit play on the host's Spotify.");
  return h("div", { class: "now" }, art(np.track), trackInfo(np.track, np.memberId ? `added by ${s.members[np.memberId]?.name ?? "?"}` : undefined));
}

function queueRow(e: QueueEntry, i: number, len: number, round: number | null): HTMLElement {
  const move = (to: number) => () => reorder(e.id, to);
  return h("li", { class: "row", "data-id": e.id },
    h("span", { class: "handle", "aria-label": "Drag to reorder", role: "button" }, "⋮⋮"),
    art(e.track), trackInfo(e.track, round !== null ? `round ${round + 1}` : undefined),
    h("div", { class: "actions" },
      h("button", { class: "icon", "aria-label": "Move up", disabled: i === 0, onclick: move(i - 1) }, "▲"),
      h("button", { class: "icon", "aria-label": "Move down", disabled: i === len - 1, onclick: move(i + 1) }, "▼"),
      h("button", { class: "icon danger", "aria-label": "Remove", onclick: () => send({ t: "remove", entryId: e.id }) }, "✕")));
}

function reorder(entryId: string, toIndex: number) {
  if (!state || !myId) return;
  // Optimistic: show it immediately, the host's next snapshot is authoritative.
  state = { ...state, queues: { ...state.queues, [myId]: moveInQueue(state.queues[myId] ?? [], entryId, toIndex) } };
  send({ t: "move", entryId, toIndex });
  render();
}

function myQueueView(s: PublicJamState): HTMLElement {
  const mine = s.queues[myId!] ?? [];
  const rounds = new Map(s.upcoming.map((u) => [u.entryId, u.round]));
  const list = h("ul", { class: "list" }, ...mine.map((e, i) => queueRow(e, i, mine.length, rounds.get(e.id) ?? null)));
  makeSortable(list, (id, to) => reorder(id, to), (d) => {
    dragging = d;
    if (!d && pendingRender) { pendingRender = false; render(); }
  });
  const tools = mine.length > 1 ? h("div", { class: "tools" },
    h("button", { class: "chip", onclick: () => send({ t: "shuffle" }) }, "🔀 Shuffle"),
    h("button", { class: "chip", onclick: () => { if (confirm(`Remove all ${mine.length} songs from your queue?`)) send({ t: "clear" }); } }, "Clear all")) : null;
  return h("div", {},
    h("div", { class: "section-head" },
      h("h2", {}, `My queue (${mine.length}/${s.settings.maxQueuePerMember})`),
      h("button", { class: "primary small", onclick: openSearch }, "+ Add")),
    ...(tools ? [tools] : []),
    mine.length ? list : h("p", { class: "muted" }, "Nothing queued. Add songs, an album or a playlist — they go into the next round."));
}

function nextView(s: PublicJamState): HTMLElement {
  const rows = s.upcoming.map((u: ScheduledItem, i) =>
    h("li", { class: "row" + (u.memberId === myId ? " mine" : "") },
      h("span", { class: "num" }, String(i + 1)), dot(u.memberId), art(u.track),
      trackInfo(u.track, u.memberId ? s.members[u.memberId]?.name : "from the playlist")));
  return h("div", {}, h("h2", {}, "Up next"), rows.length ? h("ul", { class: "list" }, ...rows) : h("p", { class: "muted" }, "The queue is empty."));
}

function peopleView(s: PublicJamState): HTMLElement {
  const rows = s.memberOrder.map((id) => {
    const m = s.members[id];
    if (!m) return null;
    return h("li", { class: "row" }, dot(id), h("div", { class: "info" },
      h("div", { class: "title" }, m.name + (id === myId ? " (you)" : "") + (m.isHost ? " · host" : "")),
      h("div", { class: "sub" }, `${s.queues[id]?.length ?? 0} queued · ${m.online ? "online" : "offline"}`)));
  });
  return h("div", {}, h("h2", {}, "In the rotation"), h("ul", { class: "list" }, ...rows),
    h("h2", { class: "spaced" }, "House rules"),
    h("ul", { class: "rules" }, ...describeRules(s.settings).map((r) => h("li", {}, r))));
}

function closeSearch() {
  searchUi = null;
  searchResults = [];
  searchCollections = [];
  searchError = "";
  sheetRoot.replaceChildren();
}

const KIND_LABEL: Record<SearchKind, string> = { track: "Songs", album: "Albums", playlist: "Playlists" };

function addCollection(c: CollectionMeta, shuffle: boolean) {
  addReq++;
  send({ t: "add-collection", reqId: String(addReq), kind: c.kind, id: c.id, shuffle });
  toast(`Adding ${c.name}…`, "info");
  render();
}

// The sheet lives outside #app so re-renders (every host snapshot) never
// rebuild the input and steal focus while someone is typing.
function openSearch() {
  let timer: ReturnType<typeof setTimeout>;
  const results = h("ul", { class: "list" });
  const input = h("input", { type: "search", placeholder: "Search", autofocus: true });
  const rulesHint = h("p", { class: "muted small" }, state ? describeRules(state.settings).slice(0, -1).join(" · ") : "");

  const fill = () => {
    if (searchError) { results.replaceChildren(h("li", { class: "error" }, searchError)); return; }
    const rows: HTMLElement[] = searchKind === "track"
      ? searchResults.map((t) =>
          h("li", { class: "row" }, art(t), trackInfo(t, formatDuration(t.durationMs)),
            h("button", { class: "primary small", onclick: () => { send({ t: "add", track: t }); closeSearch(); } }, "Add")))
      : searchCollections.map((c) =>
          h("li", { class: "row collection" }, collectionArt(c),
            h("div", { class: "info" }, h("div", { class: "title" }, c.name),
              h("div", { class: "sub" }, c.subtitle + (c.trackCount ? ` · ${c.trackCount} songs` : ""))),
            h("div", { class: "actions" },
              h("button", { class: "primary small", onclick: () => addCollection(c, false) }, "Add all"),
              h("button", { class: "chip", "aria-label": "Add shuffled", title: "Add shuffled", onclick: () => addCollection(c, true) }, "🔀"))));
    results.replaceChildren(...rows);
  };

  const run = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    searchResults = []; searchCollections = []; searchError = "";
    fill();
    if (q.length < 2) return;
    timer = setTimeout(() => {
      searchReq++;
      send({ t: "search", reqId: String(searchReq), q, kind: searchKind });
    }, 350);
  };
  input.addEventListener("input", run);

  const tabs = h("div", { class: "tabs-inline" },
    ...(["track", "album", "playlist"] as SearchKind[]).map((k) => {
      const b = h("button", { class: "tab" + (searchKind === k ? " active" : ""), onclick: () => {
        searchKind = k;
        tabs.querySelectorAll("button").forEach((el, i) => el.classList.toggle("active", ["track", "album", "playlist"][i] === k));
        input.placeholder = k === "track" ? "Search songs or artists" : k === "album" ? "Search albums" : "Search playlists";
        run();
      } }, KIND_LABEL[k]);
      return b;
    }));
  input.placeholder = "Search songs or artists";

  searchUi = { fill };
  fill();
  sheetRoot.replaceChildren(h("div", { class: "sheet" },
    h("div", { class: "section-head" }, h("h2", {}, "Add to your queue"), h("button", { class: "icon", "aria-label": "Close", onclick: closeSearch }, "✕")),
    tabs, input, rulesHint, results));
  input.focus();
}

function collectionArt(c: CollectionMeta): HTMLElement {
  return c.imageUrl && c.imageUrl.startsWith("https://") ? h("img", { class: "art", src: c.imageUrl, alt: "", loading: "lazy" }) : h("div", { class: "art" });
}

function render() {
  if (dragging) { pendingRender = true; return; }
  if (status === "kicked") {
    root.replaceChildren(h("div", { class: "join" }, h("h1", {}, "Removed"), h("p", { class: "muted" }, "The host removed this device from the session.")));
    return;
  }
  if (!state || !myId) { root.replaceChildren(joinScreen()); return; }

  const tabs = (["queue", "next", "people"] as View[]).map((v) =>
    h("button", { class: "tab" + (view === v ? " active" : ""), onclick: () => { view = v; render(); } },
      v === "queue" ? "My queue" : v === "next" ? "Up next" : "People"));
  const body = view === "queue" ? myQueueView(state) : view === "next" ? nextView(state) : peopleView(state);

  root.replaceChildren(
    h("header", {}, h("div", { class: "brand" }, state.name),
      h("div", { class: "conn " + status }, status === "online" ? "● live" : "● reconnecting…")),
    nowPlaying(state),
    h("nav", {}, ...tabs),
    ...(notice ? [h("div", { class: "toast" + (noticeKind === "info" ? " info" : "") }, notice)] : []),
    h("main", {}, body));
}

render();
connect();
