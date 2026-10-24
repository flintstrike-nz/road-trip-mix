import { createJamState, JamHost, type HostDeps } from "./host";
import type { ServerMessage } from "./protocol";
import type { JamState, TrackMeta } from "./types";

// A track with explicit artist/album, for rule tests.
export function trackBy(n: string | number, artist: string, album: string): TrackMeta {
  return { ...track(n), artists: [{ name: artist }], album: { name: album } };
}

export function track(n: string | number): TrackMeta {
  const id = String(n).padStart(22, "x");
  return {
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${n}`,
    artists: [{ name: `Artist ${n}` }],
    album: { name: `Album ${n}` },
    durationMs: 180000,
  };
}

export function makeHost(opts: { base?: TrackMeta[]; search?: HostDeps["search"]; loadCollection?: HostDeps["loadCollection"]; random?: () => number } = {}) {
  let t = 1000;
  let id = 0;
  const sent: { to: string; msg: ServerMessage }[] = [];
  const broadcasts: ServerMessage[] = [];
  const closed: string[] = [];
  const changes: JamState[] = [];
  const deps: HostDeps = {
    now: () => t,
    genId: () => `id${++id}`,
    search: opts.search,
    loadCollection: opts.loadCollection,
    random: opts.random,
    send: (to, msg) => sent.push({ to, msg }),
    broadcast: (msg) => broadcasts.push(msg),
    close: (c) => closed.push(c),
    onChange: (s) => changes.push(s),
  };
  const state = createJamState({ name: "Trip", hostName: "Host", hostMemberId: "host", base: opts.base }, deps);
  const host = new JamHost(state, deps);
  // Joins as a device and returns the (public) member id the host assigned.
  const join = (clientId: string, deviceId: string, name: string): string => {
    host.handleRaw(clientId, JSON.stringify({ t: "hello", deviceId, name, code: state.settings.joinCode }));
    const welcome = sent.filter((s) => s.to === clientId && s.msg.t === "welcome").at(-1)?.msg;
    return welcome && welcome.t === "welcome" ? welcome.memberId : "";
  };
  const queueIds = (m: string) => (host.getState().queues[m] ?? []).map((e) => e.track.name);
  const order = () => host.upcoming().map((u) => u.track.name);
  const advance = (ms: number) => { t += ms; };
  return { host, advance, sent, broadcasts, closed, changes, join, queueIds, order, state, deps };
}
