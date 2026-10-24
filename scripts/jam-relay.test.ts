import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { MemoryHistoryStore } from "../lib/history";
import { createJamState } from "../lib/jam/host";
import { JamController } from "../lib/jam/controller";
import type { ServerMessage } from "../lib/jam/protocol";
import type { PlaybackSnapshot } from "../lib/jam/spotify-backend";
import { track } from "../lib/jam/test-utils";
import { WebSocketHostTransport } from "../lib/jam/transport";
import type { PublicJamState } from "../lib/jam/types";
import { startRelay } from "./jam-relay";

let relay: Awaited<ReturnType<typeof startRelay>>;
let webRoot: string;
const cleanup: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jam-web-"));
  fs.writeFileSync(path.join(webRoot, "index.html"), "<h1>jam</h1>");
  relay = await startRelay({ port: 0, webRoot, hostOrigins: ["http://localhost:3000"] });
});

afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  await relay.close();
  fs.rmSync(webRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// --- helpers -----------------------------------------------------------------

class Joiner {
  ws: WsClient;
  msgs: ServerMessage[] = [];
  closed = false;
  constructor(port: number) {
    this.ws = new WsClient(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString())));
    this.ws.on("close", () => (this.closed = true));
    cleanup.push(() => this.ws.close());
  }
  ready() {
    return new Promise<void>((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
      this.ws.once("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async until<T>(pick: (m: ServerMessage) => T | undefined, ms = 2000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      for (const m of this.msgs) {
        const v = pick(m);
        if (v !== undefined) return v;
      }
      if (Date.now() > end) throw new Error("timeout; got " + JSON.stringify(this.msgs.map((m) => m.t)));
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  latest(): PublicJamState | undefined {
    const states = this.msgs.flatMap((m) => (m.t === "state" || m.t === "welcome" ? [m.state] : []));
    return states.sort((a, b) => a.rev - b.rev).at(-1);
  }
}

async function startHost(opts: { target?: string; base?: ReturnType<typeof track>[]; readPlayback?: () => Promise<PlaybackSnapshot | null> } = {}) {
  const state = createJamState({ name: "Trip", hostName: "Dad", hostDeviceId: "dad", base: opts.base, targetPlaylistId: opts.target });
  const history = new MemoryHistoryStore();
  const controller = new JamController({
    state,
    transport: new WebSocketHostTransport(`ws://127.0.0.1:${relay.port}/host`),
    tokens: { get: async () => "tok" },
    history,
    search: async (q) => [track(q.padEnd(3, "x"))],
    readPlayback: opts.readPlayback ?? (async () => null),
    pollIntervalMs: 20,
    syncDebounceMs: 5,
  });
  await controller.start();
  cleanup.push(() => controller.stop());
  return { controller, state, history };
}

const names = (s?: PublicJamState) => s?.upcoming.map((u) => u.track.name);

function rawGet(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

// --- tests -------------------------------------------------------------------

describe("relay", () => {
  it("serves the joiner page and refuses to escape the web root", async () => {
    expect(await rawGet(relay.port, "/")).toMatchObject({ status: 200, body: "<h1>jam</h1>" });
    expect((await rawGet(relay.port, "/nope.js")).status).toBe(404);
    fs.writeFileSync(path.join(path.dirname(webRoot), "secret.txt"), "secret");
    cleanup.push(() => fs.rmSync(path.join(path.dirname(webRoot), "secret.txt"), { force: true }));
    const r = await rawGet(relay.port, `/..%2fsecret.txt`);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("secret");
  });

  it("refuses joiners while no host is connected", async () => {
    await expect(new Joiner(relay.port).ready()).rejects.toThrow(/503/);
  });

  it("only accepts a host from loopback with an allowed origin", async () => {
    const bad = new WsClient(`ws://127.0.0.1:${relay.port}/host`, { origin: "https://evil.example" });
    await new Promise<void>((resolve) => {
      bad.on("unexpected-response", (_r, resp) => {
        expect(resp.statusCode).toBe(403);
        resolve();
      });
      bad.on("error", () => resolve());
    });
    const good = new WsClient(`ws://127.0.0.1:${relay.port}/host`, { origin: "http://localhost:3000" });
    cleanup.push(() => good.close());
    await new Promise<void>((resolve, reject) => {
      good.on("message", (d) => (JSON.parse(d.toString()).type === "ready" ? resolve() : undefined));
      good.on("error", reject);
    });
  });
});

describe("jam session over the relay", () => {
  it("runs a round-robin session between real sockets", async () => {
    const { controller, state } = await startHost();
    const ann = new Joiner(relay.port);
    const bob = new Joiner(relay.port);
    await Promise.all([ann.ready(), bob.ready()]);

    ann.send({ t: "hello", deviceId: "ann", name: "Ann", code: "WRONG" });
    expect(await ann.until((m) => (m.t === "error" ? m.code : undefined))).toBe("bad-code");

    ann.send({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode });
    bob.send({ t: "hello", deviceId: "bob", name: "Bob", code: state.settings.joinCode });
    await ann.until((m) => (m.t === "welcome" ? true : undefined));
    await bob.until((m) => (m.t === "welcome" ? true : undefined));

    controller.host.addTrack("dad", track("d1"));
    ann.send({ t: "add", track: track("a1") });
    ann.send({ t: "add", track: track("a2") });
    bob.send({ t: "add", track: track("b1") });

    await bob.until((m) => (m.t === "state" && m.state.upcoming.length === 4 ? true : undefined));
    expect(names(bob.latest())).toEqual(["Song d1", "Song a1", "Song b1", "Song a2"]);
    // every device converges on the same snapshot
    await ann.until((m) => (m.t === "state" && m.state.rev === bob.latest()!.rev ? true : undefined));
    expect(names(ann.latest())).toEqual(names(bob.latest()));

    // reorder own queue in real time
    const a2 = ann.latest()!.queues.ann[1].id;
    ann.send({ t: "move", entryId: a2, toIndex: 0 });
    await bob.until((m) => (m.t === "state" && m.state.upcoming[1]?.track.name === "Song a2" ? true : undefined));
    expect(names(bob.latest())).toEqual(["Song d1", "Song a2", "Song b1", "Song a1"]);

    // a joiner can't touch someone else's queue
    bob.send({ t: "remove", entryId: a2 });
    expect(await bob.until((m) => (m.t === "error" && m.code === "forbidden" ? true : undefined))).toBe(true);

    // search is proxied through the host
    ann.send({ t: "search", reqId: "7", q: "hey" });
    const res = await ann.until((m) => (m.t === "search-result" && m.reqId === "7" ? m.tracks : undefined));
    expect(res[0].name).toBe("Song hey");
  });

  it("drops joiners when the host goes away", async () => {
    const { controller, state } = await startHost();
    const ann = new Joiner(relay.port);
    await ann.ready();
    ann.send({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode });
    await ann.until((m) => (m.t === "welcome" ? true : undefined));
    await controller.stop();
    await vi.waitFor(() => expect(ann.closed).toBe(true));
  });

  it("marks members offline when they disconnect and removes kicked ones", async () => {
    const { controller, state } = await startHost();
    const ann = new Joiner(relay.port);
    await ann.ready();
    ann.send({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode });
    await ann.until((m) => (m.t === "welcome" ? true : undefined));
    controller.host.kick("dad", "ann");
    await ann.until((m) => (m.t === "kicked" ? true : undefined));
    await vi.waitFor(() => expect(ann.closed).toBe(true));
    expect(controller.host.getState().members.ann).toBeUndefined();
  });
});

describe("live Spotify sync and history", () => {
  // In-memory Spotify playlist behind a fake fetch.
  function fakeSpotify(initial: string[]) {
    const pl = { uris: [...initial], snap: 1 };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body as string) : {};
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (method === "GET" && url.includes("/items?")) {
        const off = Number(new URL(url).searchParams.get("offset"));
        return json({ total: pl.uris.length, items: pl.uris.slice(off, off + 100).map((uri) => ({ item: { uri } })) });
      }
      if (method === "GET") return json({ snapshot_id: String(pl.snap) });
      calls.push(method);
      if (method === "DELETE") pl.uris = pl.uris.filter((u) => !body.items.some((i: { uri: string }) => i.uri === u));
      if (method === "POST") pl.uris.push(...body.uris);
      if (method === "PUT") pl.uris = [...body.uris];
      pl.snap++;
      return json({ snapshot_id: String(pl.snap) });
    });
    return { pl, calls };
  }
  const uri = (n: string) => track(n).uri;

  it("updates the playlist live as joiners add, reorder and remove, without touching what's already played", async () => {
    const sp = fakeSpotify([uri("p1"), uri("p2"), uri("f1"), uri("f2")]);
    let playing: PlaybackSnapshot | null = null;
    const { controller, state, history } = await startHost({
      target: "PL",
      base: [track("f1"), track("f2")],
      readPlayback: async () => playing,
    });
    // p1 and p2 were already played; p2 is playing now.
    controller.host.trackStarted(track("p2"));
    playing = { isPlaying: true, progressMs: 1000, track: track("p2"), contextUri: "spotify:playlist:PL", deviceName: "Phone", fetchedAt: Date.now() };

    const ann = new Joiner(relay.port);
    await ann.ready();
    ann.send({ t: "hello", deviceId: "ann", name: "Ann", code: state.settings.joinCode });
    await ann.until((m) => (m.t === "welcome" ? true : undefined));

    ann.send({ t: "add", track: track("a1") });
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("p1"), uri("p2"), uri("a1"), uri("f1"), uri("f2")]));

    ann.send({ t: "add", track: track("a2") });
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("p1"), uri("p2"), uri("a1"), uri("a2"), uri("f1"), uri("f2")]));

    const a2 = ann.latest()!.queues.ann[1].id;
    ann.send({ t: "move", entryId: a2, toIndex: 0 });
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("p1"), uri("p2"), uri("a2"), uri("a1"), uri("f1"), uri("f2")]));

    ann.send({ t: "remove", entryId: a2 });
    await vi.waitFor(() => expect(sp.pl.uris).toEqual([uri("p1"), uri("p2"), uri("a1"), uri("f1"), uri("f2")]));

    // The player advances to Ann's song: it's recorded in history with who added it.
    playing = { ...playing, track: track("a1"), progressMs: 500, fetchedAt: Date.now() };
    await vi.waitFor(async () => expect((await history.list()).some((r) => r.track.id === track("a1").id)).toBe(true));
    const rec = (await history.list()).find((r) => r.track.id === track("a1").id)!;
    expect(rec).toMatchObject({ source: "jam", addedBy: { name: "Ann" }, jamName: "Trip", deviceName: "Phone" });
    expect(controller.host.getState().queues.ann).toHaveLength(0);
    expect(controller.host.getState().playlistLocked).toBe(3);
    // never rewrote the played prefix with a full replace
    expect(sp.calls).not.toContain("PUT");
  });
});
