import type { ResearchSearchResult } from "./types";

interface SearchResponse {
  results: ResearchSearchResult[];
  warnings: string[];
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [];
  const urls = matches.map((value) => value.trim()).filter((value) => value.length > 0);
  return Array.from(new Set(urls));
}

export async function searchResearchSources(query: string): Promise<SearchResponse> {
  // Do not depend on external search APIs.
  // Research workers rely on the runtime model's built-in search capability (e.g. Claude Code tools).
  // We only extract seed URLs explicitly present in the query/context.
  const seedUrls = extractUrls(query);
  const results: ResearchSearchResult[] = seedUrls.map((url) => ({
    title: "Seed URL from task context",
    url,
    snippet:
      "User-provided URL. Validate and gather supporting/contradicting evidence during runtime.",
    source: "seed",
  }));

  return {
    results,
    warnings: [],
  };
}
