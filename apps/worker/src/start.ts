const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 12;

function parseNodeVersion(raw: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
  };
}

function isUnsupported(version: { major: number; minor: number } | null): boolean {
  if (!version) {
    return true;
  }
  return (
    version.major < REQUIRED_MAJOR ||
    (version.major === REQUIRED_MAJOR && version.minor < REQUIRED_MINOR)
  );
}

const parsed = parseNodeVersion(process.versions.node);
if (isUnsupported(parsed)) {
  console.error(
    `[Worker] Node.js >=${REQUIRED_MAJOR}.${REQUIRED_MINOR} is required (current: ${process.version}).`,
  );
  console.error("[Worker] Please upgrade Node.js and restart the worker process.");
  process.exit(1);
}

await import("./main.js");

export {};
