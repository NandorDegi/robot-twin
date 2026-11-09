/**
 * Optional LLM opponent via a model-router endpoint.
 *
 * Set LLM_AGENT_URL to a service that accepts {"fen": "..."} and returns a
 * move as {"san": "..."} (or {"move": "..."}). If it is not set (or is
 * unreachable) the caller falls back to the built-in bot.
 */
export async function agentMove(fen: string): Promise<string | null> {
  const url = process.env.LLM_AGENT_URL;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { san?: string; move?: string };
    return data.san ?? data.move ?? null;
  } catch {
    return null;
  }
}
