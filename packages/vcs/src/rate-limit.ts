import { getOctokit } from "./client";

// Rate limit information
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

// Rate limit status
export interface RateLimitStatus {
  core: RateLimitInfo;
  search: RateLimitInfo;
  graphql: RateLimitInfo;
  isLimited: boolean;
  waitTimeMs: number;
}

// Get current rate limit status
export async function getRateLimitStatus(): Promise<RateLimitStatus> {
  const octokit = getOctokit();

  const response = await octokit.rateLimit.get();
  const { resources } = response.data;

  const now = Date.now();

  const parseResource = (resource: typeof resources.core): RateLimitInfo => ({
    limit: resource.limit,
    remaining: resource.remaining,
    reset: new Date(resource.reset * 1000),
    used: resource.used,
  });

  const core = parseResource(resources.core);
  const search = parseResource(resources.search);
  // graphql may be undefined, so set a default
  const graphql = resources.graphql
    ? parseResource(resources.graphql)
    : { limit: 0, remaining: 0, reset: new Date(), used: 0 };

  // Check if limit is reached
  const isLimited = core.remaining === 0 || search.remaining === 0;

  // Calculate wait time
  let waitTimeMs = 0;
  if (isLimited) {
    const resetTimes = [core.reset, search.reset].map((d) => d.getTime());
    const nextReset = Math.min(...resetTimes);
    waitTimeMs = Math.max(0, nextReset - now + 1000); // 1 second buffer
  }

  return {
    core,
    search,
    graphql,
    isLimited,
    waitTimeMs,
  };
}

// Wait when rate limit is reached
export async function waitForRateLimit(): Promise<void> {
  const status = await getRateLimitStatus();

  if (status.isLimited && status.waitTimeMs > 0) {
    console.log(`[GitHub] Rate limit reached. Waiting ${Math.ceil(status.waitTimeMs / 1000)}s...`);
    await new Promise((resolve) => setTimeout(resolve, status.waitTimeMs));
  }
}

// Call API with rate limit handling
export async function withRateLimitHandling<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 60000;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Check rate limit status
      const status = await getRateLimitStatus();
      if (status.isLimited) {
        console.log(
          `[GitHub] Rate limit active. Waiting ${Math.ceil(status.waitTimeMs / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, status.waitTimeMs));
      }

      // Execute
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if rate limit error
      const isRateLimitError =
        lastError.message.includes("rate limit") ||
        lastError.message.includes("403") ||
        lastError.message.includes("secondary rate limit");

      if (isRateLimitError && attempt < maxRetries) {
        const waitTime = retryDelayMs * Math.pow(2, attempt);
        console.log(
          `[GitHub] Rate limit error, retrying in ${Math.ceil(waitTime / 1000)}s... ` +
            `(attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } else {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

// Log rate limit status
export async function logRateLimitStatus(): Promise<void> {
  const status = await getRateLimitStatus();

  console.log("[GitHub Rate Limit]");
  console.log(
    `  Core: ${status.core.remaining}/${status.core.limit} (resets at ${status.core.reset.toISOString()})`,
  );
  console.log(
    `  Search: ${status.search.remaining}/${status.search.limit} (resets at ${status.search.reset.toISOString()})`,
  );
  console.log(
    `  GraphQL: ${status.graphql.remaining}/${status.graphql.limit} (resets at ${status.graphql.reset.toISOString()})`,
  );

  if (status.isLimited) {
    console.log(`  ** RATE LIMITED ** Wait time: ${Math.ceil(status.waitTimeMs / 1000)}s`);
  }
}
