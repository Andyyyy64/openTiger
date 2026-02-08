import { stat } from "node:fs/promises";
import { join } from "node:path";

export function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function normalizeStringList(items: unknown, maxItems: number): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => clipText(item, 200));
}

export function extractIssueMessages(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages = value
    .map((item) => {
      if (typeof item === "object" && item !== null && "message" in item) {
        const message = (item as { message?: unknown }).message;
        if (typeof message === "string") {
          return message;
        }
      }
      return undefined;
    })
    .filter((item): item is string => typeof item === "string");

  return messages.slice(0, maxItems).map((item) => clipText(item, 200));
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function isRepoUninitialized(workdir: string): Promise<boolean> {
  const hasApps = await pathIsDirectory(join(workdir, "apps"));
  const hasPackages = await pathIsDirectory(join(workdir, "packages"));

  if (hasApps || hasPackages) {
    return false;
  }

  const hasRootPackage = await pathIsFile(join(workdir, "package.json"));
  const hasWorkspace = await pathIsFile(join(workdir, "pnpm-workspace.yaml"));

  return !hasRootPackage && !hasWorkspace;
}
