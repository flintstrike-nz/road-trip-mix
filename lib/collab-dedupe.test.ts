import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeFavorites } from "./collab-mix";
import type { ScoredTrack } from "./library-track";
import { generateAiMix } from "./openrouter";

afterEach(() => vi.unstubAllGlobals());

describe("Collaborative Mix never lists a song twice", () => {
  it("drops repeated ids from the AI's answer, keeping the first position", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"title":"Trip","trackIds":["a","b","a","zzz","c","b"],"note":"n"}' } }],
          }),
          { status: 200 }
        )
    );
    const cands = ["a", "b", "c"].map((id) => ({ id, name: id, artists: "x", fromAccounts: ["Dad"] }));
    const res = await generateAiMix(cands, "vibe", 3, undefined, "key");
    expect(res.trackIds).toEqual(["a", "b", "c"]); // no repeats, unknown id dropped, order kept
  });

  const track = (provider: "spotify" | "apple", id: string, name: string, artist: string): ScoredTrack => ({
    provider, id, name, artists: [artist], albumName: "A", durationMs: 1000, score: 1,
    spotifyUri: provider === "spotify" ? `spotify:track:${id}` : undefined,
  });

  it("merges the same song across accounts and services, however it's punctuated", () => {
    const merged = mergeFavorites([
      { accountId: "dad", label: "Dad", tracks: [track("spotify", "s1", "Don't Stop Me Now", "Queen")] },
      { accountId: "mum", label: "Mum", tracks: [track("spotify", "s2", "Dont Stop Me Now", "QUEEN")] },
      { accountId: "kid", label: "Kid", tracks: [track("apple", "a1", "Don’t Stop Me Now", "Queen")] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].fromAccounts.sort()).toEqual(["Dad", "Kid", "Mum"]);
  });
});
