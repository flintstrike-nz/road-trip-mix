import { describe, expect, it, vi } from "vitest";
import { applySyncPlan, lockedCount, planTailSync, syncGeneratedLive, syncPlaylistLive } from "./spotify-sync";

const u = (...ids: string[]) => ids.map((i) => `spotify:track:${i}`);

describe("planTailSync", () => {
  it("is a no-op when nothing changed", () => {
    expect(planTailSync(u("a", "b", "c"), u("c"), 2)).toEqual({ kind: "noop" });
  });

  it("only appends when the new song goes on the end", () => {
    expect(planTailSync(u("a", "b", "c"), u("c", "d"), 2)).toEqual({ kind: "tail", keep: 3, remove: [], add: u("d") });
  });

  it("rewrites from the first difference and never touches the locked prefix", () => {
    const plan = planTailSync(u("a", "b", "c", "d"), u("x", "c", "d"), 2);
    expect(plan).toEqual({ kind: "tail", keep: 2, remove: u("c", "d"), add: u("x", "c", "d") });
  });

  it("keeps a matching upcoming prefix", () => {
    const plan = planTailSync(u("a", "b", "c", "d"), u("c", "x", "d"), 2);
    expect(plan).toEqual({ kind: "tail", keep: 3, remove: u("d"), add: u("x", "d") });
  });

  it("handles removals at the tail", () => {
    expect(planTailSync(u("a", "b", "c"), [], 1)).toEqual({ kind: "tail", keep: 1, remove: u("b", "c"), add: [] });
  });

  it("falls back to a full replace when removal by URI would be ambiguous", () => {
    const plan = planTailSync(u("a", "b", "a"), u("b"), 1);
    expect(plan).toEqual({ kind: "replace", uris: u("a", "b") });
  });

  it("falls back to replace when the tail has local files", () => {
    const plan = planTailSync([...u("a"), "local:1"], u("z"), 1);
    expect(plan.kind).toBe("replace");
  });

  it("rewrites everything when nothing is locked", () => {
    expect(planTailSync(u("a", "b"), u("b", "a"), 0)).toEqual({ kind: "tail", keep: 0, remove: u("a", "b"), add: u("b", "a") });
  });
});

describe("lockedCount", () => {
  it("locks through the playing track", () => {
    expect(lockedCount(u("a", "b", "c"), "spotify:track:b")).toBe(2);
  });
  it("locks nothing if the track isn't in the playlist or nothing plays", () => {
    expect(lockedCount(u("a"), "spotify:track:z")).toBe(0);
    expect(lockedCount(u("a"), null)).toBe(0);
  });
  it("respects the search start for repeated songs", () => {
    expect(lockedCount(u("a", "b", "a"), "spotify:track:a", 1)).toBe(3);
  });
  it("finds the copy at the start position itself, so an unchanged position stays put", () => {
    expect(lockedCount(u("a", "b", "a", "c"), "spotify:track:a", 2)).toBe(3);
  });
  it("can lock through the last copy of a repeated song, to never rewrite played tracks", () => {
    expect(lockedCount(u("a", "b", "a", "c"), "spotify:track:a", 0, "last")).toBe(3);
    expect(lockedCount(u("a", "b", "c"), "spotify:track:z", 0, "last")).toBe(0);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
    const out = handler(url, init) as { status?: number; json?: unknown } | undefined;
    return new Response(JSON.stringify(out?.json ?? {}), { status: out?.status ?? 200 });
  });
  return { impl, calls };
}

describe("applySyncPlan / syncPlaylistLive", () => {
  const tokens = { get: async () => "tok" };

  it("deletes the tail by URI then appends, in 100-item batches", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { snapshot_id: "s2" } }));
    vi.stubGlobal("fetch", impl);
    const many = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);
    await applySyncPlan(tokens, "PL", { kind: "tail", keep: 1, remove: many, add: many.slice(0, 120) }, "s1");
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["DELETE", "DELETE", "POST", "POST"]);
    expect((calls[0].body as { items: unknown[]; snapshot_id: string }).items).toHaveLength(100);
    expect((calls[1].body as { snapshot_id: string }).snapshot_id).toBe("s2");
    expect((calls[3].body as { uris: string[] }).uris).toHaveLength(20);
    vi.unstubAllGlobals();
  });

  it("replace sends the first 100 with PUT and appends the rest", async () => {
    const { impl, calls } = fakeFetch(() => ({}));
    vi.stubGlobal("fetch", impl);
    const many = Array.from({ length: 101 }, (_, i) => `spotify:track:t${i}`);
    await applySyncPlan(tokens, "PL", { kind: "replace", uris: many });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "POST"]);
    vi.unstubAllGlobals();
  });

  it("reads the playlist, plans around the playing track and applies it", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/items?")) return { json: { total: 3, items: u("a", "b", "c").map((uri) => ({ item: { uri } })) } };
      if (url.includes("fields=snapshot_id")) return { json: { snapshot_id: "s1" } };
      return { json: { snapshot_id: "s2" } };
    });
    vi.stubGlobal("fetch", impl);
    const plan = await syncPlaylistLive(tokens, "PL", u("x", "c"), "spotify:track:a");
    expect(plan).toEqual({ kind: "tail", keep: 1, remove: u("b", "c"), add: u("x", "c") });
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["DELETE", "POST"]);
    vi.unstubAllGlobals();
  });

  it("retries once with a refreshed token on 401", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => (n++ === 0 ? { status: 401 } : { json: { items: [], total: 0 } }));
    vi.stubGlobal("fetch", impl);
    const refresh = vi.fn(async () => "fresh");
    const { getPlaylistUris } = await import("./spotify-sync");
    await getPlaylistUris({ get: async () => "old", refresh }, "PL");
    expect(refresh).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("syncGeneratedLive keeps played songs in place and doesn't repeat them", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/items?")) return { json: { total: 4, items: u("a", "b", "c", "d").map((uri) => ({ item: { uri } })) } };
      if (url.includes("fields=snapshot_id")) return { json: { snapshot_id: "s1" } };
      return { json: { snapshot_id: "s2" } };
    });
    vi.stubGlobal("fetch", impl);
    // b is playing; the regenerated order is d, a, x, c, b
    const plan = await syncGeneratedLive(tokens, "PL", u("d", "a", "x", "c", "b"), "spotify:track:b");
    expect(plan).toEqual({ kind: "tail", keep: 2, remove: u("c", "d"), add: u("d", "x", "c") });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    vi.unstubAllGlobals();
  });
});
