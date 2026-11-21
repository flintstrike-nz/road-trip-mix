// Thin client for OpenRouter's chat-completions API, used to let an LLM
// curate and order a road-trip mix from a pool of candidate tracks.

export type CandidateTrack = {
  id: string;
  name: string;
  artists: string;
  fromAccounts: string[];
};

export type AiMixResult = {
  title: string;
  trackIds: string[];
  note?: string;
};

const DEFAULT_MODEL = "openai/gpt-4o-mini";

function buildPrompt(candidates: CandidateTrack[], vibe: string, targetCount: number) {
  const catalog = candidates
    .map((t, i) => `${i + 1}. [${t.id}] "${t.name}" — ${t.artists} (from: ${t.fromAccounts.join(", ")})`)
    .join("\n");

  return [
    {
      role: "system" as const,
      content:
        "You are a music curator building a collaborative road-trip playlist for a group of friends. " +
        "You are given a pool of candidate tracks pulled from each friend's current favorites (recently " +
        "played, top tracks, and recently saved). Pick and order the best subset for the requested vibe, " +
        "trying to represent multiple people's tastes rather than favoring one account. " +
        "Respond with ONLY minified JSON matching this shape, no prose, no markdown fences: " +
        '{"title": string, "trackIds": string[], "note": string}. ' +
        "trackIds must be the bracketed [id] values from the catalog, in playback order.",
    },
    {
      role: "user" as const,
      content:
        `Vibe / occasion: ${vibe || "a fun road trip"}\n` +
        `Target track count: about ${targetCount}\n\n` +
        `Candidate pool:\n${catalog}`,
    },
  ];
}

export async function generateAiMix(
  candidates: CandidateTrack[],
  vibe: string,
  targetCount = 20,
  model = DEFAULT_MODEL,
  apiKey?: string | null
): Promise<AiMixResult> {
  if (!apiKey) throw new Error("No OpenRouter API key configured. Connect one in Settings.");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(process.env.NEXTAUTH_URL ? { "HTTP-Referer": process.env.NEXTAUTH_URL } : {}),
      "X-Title": "Road Trip Mix",
    },
    body: JSON.stringify({
      model,
      messages: buildPrompt(candidates, vibe, targetCount),
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";

  let parsed: AiMixResult;
  try {
    const jsonText = content.trim().replace(/^```(json)?/, "").replace(/```$/, "").trim();
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("OpenRouter returned a response that could not be parsed as JSON");
  }

  const validIds = new Set(candidates.map((c) => c.id));
  // Models sometimes repeat an id; a song must appear once, in the position it was first given.
  const trackIds = Array.from(new Set((parsed.trackIds ?? []).filter((id) => validIds.has(id))));

  return {
    title: parsed.title || "AI Road Trip Mix",
    trackIds,
    note: parsed.note,
  };
}
