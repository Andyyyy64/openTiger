import fs from "fs";
import path from "path";

// Directory patterns to exclude
const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  "public",
  "prisma/migrations",
  "app/components/ui",
];

// File extensions to check
const TARGET_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
];

// Default line count threshold
const DEFAULT_LINE_THRESHOLD = 500;

interface FileInfo {
  filePath: string;
  lineCount: number;
}

interface CliOptions {
  lineThreshold?: number;
  ignorePathSubstrings: string[];
}

/**
 * Count the number of lines in a file
 */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").length;
  } catch {
    console.warn(`Warning: Could not read file ${filePath}`);
    return 0;
  }
}

/**
 * Check whether a directory should be excluded
 */
function isExcludedDir(dirPath: string, projectRoot: string): boolean {
  const dirName = path.basename(dirPath);
  const relativePath = path.relative(projectRoot, dirPath);

  return EXCLUDED_DIRS.some((excluded) => {
    // Exact match on directory name
    if (dirName === excluded) {
      return true;
    }

    // Exact match on relative path
    if (relativePath === excluded) {
      return true;
    }

    // If relative path starts with excluded path (also excludes subdirectories)
    if (relativePath.startsWith(excluded + path.sep) || relativePath.startsWith(excluded + "/")) {
      return true;
    }

    // If full path contains the excluded path
    return dirPath.includes(`/${excluded}/`) || dirPath.includes(`\\${excluded}\\`);
  });
}

/**
 * Check whether a file is a target for checking
 */
function isTargetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TARGET_EXTENSIONS.includes(ext);
}

/**
 * Determine path exclusion (-I/--ignore)
 *
 * - Checks whether the relative path (normalized to "/" separators) contains the specified substring
 * - Path separators are always treated as "/" to absorb OS differences
 * - Comparison is case-insensitive to avoid unintentional misses
 */
function isIgnoredPath(
  absolutePath: string,
  projectRoot: string,
  ignorePathSubstrings: string[],
): boolean {
  if (ignorePathSubstrings.length === 0) {
    return false;
  }

  const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join("/");

  const haystack = relativePath.toLowerCase();
  return ignorePathSubstrings.some((needle) => haystack.includes(needle.toLowerCase()));
}

/**
 * Recursively scan a directory and collect file information
 */
function scanDirectory(
  dirPath: string,
  ignorePathSubstrings: string[] = [],
  projectRoot: string = dirPath,
): FileInfo[] {
  const results: FileInfo[] = [];

  try {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip paths containing the specified substring, including all descendants
        if (isIgnoredPath(fullPath, projectRoot, ignorePathSubstrings)) {
          continue;
        }

        // Skip excluded directories
        if (!isExcludedDir(fullPath, projectRoot)) {
          results.push(...scanDirectory(fullPath, ignorePathSubstrings, projectRoot));
        }
      } else if (stat.isFile() && isTargetFile(fullPath)) {
        // Skip files whose path contains the specified substring
        if (isIgnoredPath(fullPath, projectRoot, ignorePathSubstrings)) {
          continue;
        }

        const lineCount = countLines(fullPath);
        results.push({
          filePath: fullPath,
          lineCount,
        });
      }
    }
  } catch {
    console.warn(`Warning: Could not read directory ${dirPath}`);
  }

  return results;
}

/**
 * Parse command-line arguments
 *
 * Examples:
 * - npm run line -- -I prisma
 * - npm run line -- --ignore app/components --ignore server/api/domain
 * - npm run line -- 600 -I docs
 */
function parseCliOptions(args: string[]): CliOptions {
  const ignorePathSubstrings: string[] = [];
  let lineThreshold: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (arg === "-I" || arg === "--ignore") {
      const value = args[i + 1];
      if (value) {
        ignorePathSubstrings.push(value);
        i++;
      }
      continue;
    }

    if (arg.startsWith("--ignore=")) {
      const value = arg.slice("--ignore=".length);
      if (value) {
        ignorePathSubstrings.push(value);
      }
      continue;
    }

    if (arg === "-t" || arg === "--threshold") {
      const value = args[i + 1];
      const threshold = parseInt(value ?? "0", 10);
      if (!isNaN(threshold) && threshold > 0) {
        lineThreshold = threshold;
        i++;
      }
      continue;
    }

    if (arg.startsWith("--threshold=")) {
      const value = arg.slice("--threshold=".length);
      if (value) {
        const threshold = parseInt(value, 10);
        if (!isNaN(threshold) && threshold > 0) {
          lineThreshold = threshold;
        }
      }
      continue;
    }

    // Backward compatibility: treat the first non-flag numeric argument as the threshold (legacy `npm run line 600`)
    if (!arg.startsWith("-") && lineThreshold === undefined) {
      const threshold = parseInt(arg, 10);
      if (!isNaN(threshold) && threshold > 0) {
        lineThreshold = threshold;
        continue;
      }
    }
  }

  return {
    lineThreshold,
    ignorePathSubstrings,
  };
}

/**
 * Get the line count threshold
 */
function getLineThreshold(cliLineThreshold?: number): number {
  if (cliLineThreshold && cliLineThreshold > 0) {
    return cliLineThreshold;
  }

  // Extract the script name from npm_lifecycle_event and parse the number after ":"
  // Example: "line:500" -> 500
  const lifecycleEvent = process.env.npm_lifecycle_event;
  if (lifecycleEvent) {
    const scriptName = lifecycleEvent.split(":")[0];
    const thresholdPart = lifecycleEvent.split(":")[1];

    // If a number is specified after ":" in the "line" script
    if (scriptName === "line" && thresholdPart) {
      const threshold = parseInt(thresholdPart, 10);
      if (!isNaN(threshold) && threshold > 0) {
        return threshold;
      }
    }
  }

  return DEFAULT_LINE_THRESHOLD;
}

/**
 * Main process
 */
function main() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const lineThreshold = getLineThreshold(cliOptions.lineThreshold);

  console.log(`🔍 Checking file line counts (threshold: ${lineThreshold} lines)...\n`);

  const projectRoot = process.cwd();
  const allFiles = scanDirectory(projectRoot, cliOptions.ignorePathSubstrings, projectRoot);

  // Filter files that meet or exceed the threshold
  const largeFiles = allFiles.filter((file) => file.lineCount >= lineThreshold);

  // Sort results by line count (descending)
  largeFiles.sort((a, b) => b.lineCount - a.lineCount);

  // Categorize files by type
  const frontendFiles = largeFiles.filter((file) => {
    const relativePath = path.relative(projectRoot, file.filePath);
    return relativePath.startsWith("app/");
  });

  const serverFiles = largeFiles.filter((file) => {
    const relativePath = path.relative(projectRoot, file.filePath);
    return relativePath.startsWith("server/");
  });

  const otherFiles = largeFiles.filter((file) => {
    const relativePath = path.relative(projectRoot, file.filePath);
    return !relativePath.startsWith("app/") && !relativePath.startsWith("server/");
  });

  if (largeFiles.length === 0) {
    console.log(`✅ All files are under ${lineThreshold} lines!`);
  } else {
    console.log(`⚠️  Found ${largeFiles.length} file(s) with ${lineThreshold}+ lines:\n`);

    // Display frontend files
    if (frontendFiles.length > 0) {
      console.log(`🌐 Frontend (${frontendFiles.length} files):`);
      frontendFiles.forEach((file) => {
        const relativePath = path.relative(projectRoot, file.filePath);
        console.log(`📄 ${relativePath}: ${file.lineCount} lines`);
      });
      console.log("");
    }

    // Display server files
    if (serverFiles.length > 0) {
      console.log(`🖥️  Server (${serverFiles.length} files):`);
      serverFiles.forEach((file) => {
        const relativePath = path.relative(projectRoot, file.filePath);
        console.log(`📄 ${relativePath}: ${file.lineCount} lines`);
      });
      console.log("");
    }

    // Display other files
    if (otherFiles.length > 0) {
      console.log(`📁 Other (${otherFiles.length} files):`);
      otherFiles.forEach((file) => {
        const relativePath = path.relative(projectRoot, file.filePath);
        console.log(`📄 ${relativePath}: ${file.lineCount} lines`);
      });
      console.log("");
    }

    console.log(
      `\n💡 Consider refactoring files with ${lineThreshold}+ lines for better maintainability.`,
    );
  }

  // Statistics
  const totalFiles = allFiles.length;
  const averageLines = Math.round(
    allFiles.reduce((sum, file) => sum + file.lineCount, 0) / totalFiles,
  );

  console.log(`\n📊 Statistics:`);
  console.log(`   Total files checked: ${totalFiles}`);
  console.log(`   Average lines per file: ${averageLines}`);
  console.log(`   Files over ${lineThreshold} lines: ${largeFiles.length}`);

  // Statistics by category
  if (largeFiles.length > 0) {
    if (frontendFiles.length > 0) {
      const frontendTotalLines = frontendFiles.reduce((sum, file) => sum + file.lineCount, 0);
      const frontendAvg = Math.round(frontendTotalLines / frontendFiles.length);
      console.log(
        `   🌐 Frontend - Large files: ${frontendFiles.length}, Avg lines: ${frontendAvg}`,
      );
    }

    if (serverFiles.length > 0) {
      const serverTotalLines = serverFiles.reduce((sum, file) => sum + file.lineCount, 0);
      const serverAvg = Math.round(serverTotalLines / serverFiles.length);
      console.log(`   🖥️  Server - Large files: ${serverFiles.length}, Avg lines: ${serverAvg}`);
    }

    if (otherFiles.length > 0) {
      const otherTotalLines = otherFiles.reduce((sum, file) => sum + file.lineCount, 0);
      const otherAvg = Math.round(otherTotalLines / otherFiles.length);
      console.log(`   📁 Other - Large files: ${otherFiles.length}, Avg lines: ${otherAvg}`);
    }
  }
}

// Run script
main();
