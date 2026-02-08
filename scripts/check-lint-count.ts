import fs from "fs";
import path from "path";

// 除外するディレクトリのパターン
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

// チェック対象のファイル拡張子
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

// デフォルトの行数閾値
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
 * ファイルの行数をカウントする
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
 * ディレクトリが除外対象かどうかをチェック
 */
function isExcludedDir(dirPath: string, projectRoot: string): boolean {
  const dirName = path.basename(dirPath);
  const relativePath = path.relative(projectRoot, dirPath);

  return EXCLUDED_DIRS.some((excluded) => {
    // ディレクトリ名での完全一致
    if (dirName === excluded) {
      return true;
    }

    // 相対パスでの完全一致
    if (relativePath === excluded) {
      return true;
    }

    // 相対パスが除外パスで始まる場合（サブディレクトリも除外）
    if (
      relativePath.startsWith(excluded + path.sep) ||
      relativePath.startsWith(excluded + "/")
    ) {
      return true;
    }

    // フルパスに除外パスが含まれる場合
    return (
      dirPath.includes(`/${excluded}/`) || dirPath.includes(`\\${excluded}\\`)
    );
  });
}

/**
 * ファイルがチェック対象かどうかをチェック
 */
function isTargetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TARGET_EXTENSIONS.includes(ext);
}

/**
 * パス除外（-I/--ignore）の判定
 *
 * - 「相対パス（/区切りに正規化）」に、指定された文字列が含まれるかで判定する
 * - OS差分を吸収するため、パス区切りは常に "/" として扱う
 * - 文字大小の差で意図せず漏れないよう、比較は小文字化して行う
 */
function isIgnoredPath(
  absolutePath: string,
  projectRoot: string,
  ignorePathSubstrings: string[],
): boolean {
  if (ignorePathSubstrings.length === 0) {
    return false;
  }

  const relativePath = path
    .relative(projectRoot, absolutePath)
    .split(path.sep)
    .join("/");

  const haystack = relativePath.toLowerCase();
  return ignorePathSubstrings.some((needle) =>
    haystack.includes(needle.toLowerCase()),
  );
}

/**
 * ディレクトリを再帰的に走査してファイル情報を取得
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
        // 指定文字列を含むパスは、その配下ごとスキップする
        if (isIgnoredPath(fullPath, projectRoot, ignorePathSubstrings)) {
          continue;
        }

        // 除外ディレクトリをスキップ
        if (!isExcludedDir(fullPath, projectRoot)) {
          results.push(
            ...scanDirectory(fullPath, ignorePathSubstrings, projectRoot),
          );
        }
      } else if (stat.isFile() && isTargetFile(fullPath)) {
        // 指定文字列を含むファイルはスキップする
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
 * コマンドライン引数を解釈する
 *
 * 例:
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

    // 互換性: 最初の「フラグではない数値」を閾値として扱う（従来の `npm run line 600`）
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
 * 行数閾値を取得
 */
function getLineThreshold(cliLineThreshold?: number): number {
  if (cliLineThreshold && cliLineThreshold > 0) {
    return cliLineThreshold;
  }

  // npm_lifecycle_event からスクリプト名を取得して :以降の数値を抽出
  // 例: "line:500" → 500
  const lifecycleEvent = process.env.npm_lifecycle_event;
  if (lifecycleEvent) {
    const scriptName = lifecycleEvent.split(":")[0];
    const thresholdPart = lifecycleEvent.split(":")[1];

    // "line" スクリプトで:以降に数値が指定されている場合
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
 * メイン処理
 */
function main() {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const lineThreshold = getLineThreshold(cliOptions.lineThreshold);

  console.log(
    `🔍 Checking file line counts (threshold: ${lineThreshold} lines)...\n`,
  );

  const projectRoot = process.cwd();
  const allFiles = scanDirectory(
    projectRoot,
    cliOptions.ignorePathSubstrings,
    projectRoot,
  );

  // 閾値以上のファイルをフィルタリング
  const largeFiles = allFiles.filter((file) => file.lineCount >= lineThreshold);

  // 結果を行数でソート（降順）
  largeFiles.sort((a, b) => b.lineCount - a.lineCount);

  // ファイルをカテゴリ別に分類
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
    return (
      !relativePath.startsWith("app/") && !relativePath.startsWith("server/")
    );
  });

  if (largeFiles.length === 0) {
    console.log(`✅ All files are under ${lineThreshold} lines!`);
  } else {
    console.log(
      `⚠️  Found ${largeFiles.length} file(s) with ${lineThreshold}+ lines:\n`,
    );

    // フロントエンドファイルの表示
    if (frontendFiles.length > 0) {
      console.log(`🌐 フロントエンド (${frontendFiles.length} files):`);
      frontendFiles.forEach((file) => {
        const relativePath = path.relative(projectRoot, file.filePath);
        console.log(`📄 ${relativePath}: ${file.lineCount} lines`);
      });
      console.log("");
    }

    // サーバーファイルの表示
    if (serverFiles.length > 0) {
      console.log(`🖥️  サーバー (${serverFiles.length} files):`);
      serverFiles.forEach((file) => {
        const relativePath = path.relative(projectRoot, file.filePath);
        console.log(`📄 ${relativePath}: ${file.lineCount} lines`);
      });
      console.log("");
    }

    // その他のファイルの表示
    if (otherFiles.length > 0) {
      console.log(`📁 その他 (${otherFiles.length} files):`);
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

  // 統計情報
  const totalFiles = allFiles.length;
  const averageLines = Math.round(
    allFiles.reduce((sum, file) => sum + file.lineCount, 0) / totalFiles,
  );

  console.log(`\n📊 Statistics:`);
  console.log(`   Total files checked: ${totalFiles}`);
  console.log(`   Average lines per file: ${averageLines}`);
  console.log(`   Files over ${lineThreshold} lines: ${largeFiles.length}`);

  // カテゴリ別の統計
  if (largeFiles.length > 0) {
    if (frontendFiles.length > 0) {
      const frontendTotalLines = frontendFiles.reduce(
        (sum, file) => sum + file.lineCount,
        0,
      );
      const frontendAvg = Math.round(frontendTotalLines / frontendFiles.length);
      console.log(
        `   🌐 Frontend - Large files: ${frontendFiles.length}, Avg lines: ${frontendAvg}`,
      );
    }

    if (serverFiles.length > 0) {
      const serverTotalLines = serverFiles.reduce(
        (sum, file) => sum + file.lineCount,
        0,
      );
      const serverAvg = Math.round(serverTotalLines / serverFiles.length);
      console.log(
        `   🖥️  Server - Large files: ${serverFiles.length}, Avg lines: ${serverAvg}`,
      );
    }

    if (otherFiles.length > 0) {
      const otherTotalLines = otherFiles.reduce(
        (sum, file) => sum + file.lineCount,
        0,
      );
      const otherAvg = Math.round(otherTotalLines / otherFiles.length);
      console.log(
        `   📁 Other - Large files: ${otherFiles.length}, Avg lines: ${otherAvg}`,
      );
    }
  }
}

// スクリプト実行
main();