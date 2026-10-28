import { z } from "zod";

const searchResponse = z.object({
  web: z.object({
    results: z.array(z.object({ title: z.string(), url: z.string().url(), description: z.string() })).default([])
  }).optional()
});

const githubResponse = z.object({
  total_count: z.number(),
  items: z.array(z.object({
    full_name: z.string(),
    html_url: z.string().url(),
    description: z.string().nullable(),
    stargazers_count: z.number(),
    language: z.string().nullable()
  }))
});

async function getJson(url: URL, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response.ok) {
    // Do not surface response bodies that may contain credentials or provider internals.
    throw new Error(`Upstream request failed (HTTP ${response.status}). Check credentials or rate limits.`);
  }
  if (!response.body) {
    throw new Error("Upstream response has no body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Upstream response exceeds 1 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function searchWeb(query: string, count: number): Promise<unknown> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) {
    throw new Error("Web search is not configured. Set BRAVE_SEARCH_API_KEY in .env and restart.");
  }
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const data = searchResponse.parse(await getJson(url, { "X-Subscription-Token": key, Accept: "application/json" }));
  return { results: data.web?.results ?? [] };
}

export async function searchGithub(query: string, count: number): Promise<unknown> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(count));
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ToolBridge-AI",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const data = githubResponse.parse(await getJson(url, headers));
  return { totalCount: data.total_count, repositories: data.items };
}
