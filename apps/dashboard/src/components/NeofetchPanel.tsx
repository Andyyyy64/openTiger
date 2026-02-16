import React from "react";

type AnsiStyleState = {
  color?: string;
  backgroundColor?: string;
  fontWeight?: React.CSSProperties["fontWeight"];
};

type AnsiChunk = {
  text: string;
  style: React.CSSProperties;
};

type ParsedNeofetchOutput = {
  infoLines: AnsiChunk[][];
  logoLines: AnsiChunk[][];
};

type NeofetchPanelProps = {
  output: string;
  onReload?: () => void;
  isReloading?: boolean;
};

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_BELL = String.fromCharCode(7);
const ANSI_SEQUENCE_REGEX = new RegExp(
  `${ANSI_ESCAPE}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${ANSI_BELL}]*(?:${ANSI_BELL}|${ANSI_ESCAPE}\\\\))`,
  "gu",
);
const ANSI_BASE_COLORS = [
  "#000000",
  "#aa0000",
  "#00aa00",
  "#aa5500",
  "#0000aa",
  "#aa00aa",
  "#00aaaa",
  "#aaaaaa",
  "#555555",
  "#ff5555",
  "#55ff55",
  "#ffff55",
  "#5555ff",
  "#ff55ff",
  "#55ffff",
  "#ffffff",
];

function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_SEQUENCE_REGEX, "");
}

function resolveAnsi256Color(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    return undefined;
  }
  if (value < 16) {
    return ANSI_BASE_COLORS[value];
  }
  if (value < 232) {
    const index = value - 16;
    const red = Math.floor(index / 36);
    const green = Math.floor((index % 36) / 6);
    const blue = index % 6;
    const toChannel = (component: number) => (component === 0 ? 0 : 55 + component * 40);
    return `rgb(${toChannel(red)}, ${toChannel(green)}, ${toChannel(blue)})`;
  }
  const gray = 8 + (value - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applySgrCodes(rawCodes: string, state: AnsiStyleState): void {
  const codes =
    rawCodes.length > 0 ? rawCodes.split(";").map((part) => Number.parseInt(part, 10)) : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = Number.isFinite(codes[index]) ? codes[index] : 0;
    if (code === 0) {
      state.color = undefined;
      state.backgroundColor = undefined;
      state.fontWeight = undefined;
      continue;
    }
    if (code === 1) {
      state.fontWeight = "bold";
      continue;
    }
    if (code === 22) {
      state.fontWeight = undefined;
      continue;
    }
    if (code === 39) {
      state.color = undefined;
      continue;
    }
    if (code === 49) {
      state.backgroundColor = undefined;
      continue;
    }
    if (code >= 30 && code <= 37) {
      state.color = ANSI_BASE_COLORS[code - 30];
      continue;
    }
    if (code >= 90 && code <= 97) {
      state.color = ANSI_BASE_COLORS[code - 90 + 8];
      continue;
    }
    if (code >= 40 && code <= 47) {
      state.backgroundColor = ANSI_BASE_COLORS[code - 40];
      continue;
    }
    if (code >= 100 && code <= 107) {
      state.backgroundColor = ANSI_BASE_COLORS[code - 100 + 8];
      continue;
    }
    if (code !== 38 && code !== 48) {
      continue;
    }

    const nextMode = codes[index + 1];
    if (nextMode === 5 && index + 2 < codes.length) {
      const resolved = resolveAnsi256Color(codes[index + 2] ?? -1);
      if (resolved) {
        if (code === 38) {
          state.color = resolved;
        } else {
          state.backgroundColor = resolved;
        }
      }
      index += 2;
      continue;
    }

    if (nextMode === 2 && index + 4 < codes.length) {
      const red = codes[index + 2];
      const green = codes[index + 3];
      const blue = codes[index + 4];
      if (
        Number.isFinite(red) &&
        Number.isFinite(green) &&
        Number.isFinite(blue) &&
        red >= 0 &&
        red <= 255 &&
        green >= 0 &&
        green <= 255 &&
        blue >= 0 &&
        blue <= 255
      ) {
        const rgb = `rgb(${red}, ${green}, ${blue})`;
        if (code === 38) {
          state.color = rgb;
        } else {
          state.backgroundColor = rgb;
        }
      }
      index += 4;
    }
  }
}

function parseAnsiLine(line: string): AnsiChunk[] {
  const chunks: AnsiChunk[] = [];
  const state: AnsiStyleState = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  ANSI_SEQUENCE_REGEX.lastIndex = 0;
  while ((match = ANSI_SEQUENCE_REGEX.exec(line)) !== null) {
    if (match.index > cursor) {
      chunks.push({
        text: line.slice(cursor, match.index),
        style: {
          ...(state.color ? { color: state.color } : {}),
          ...(state.backgroundColor ? { backgroundColor: state.backgroundColor } : {}),
          ...(state.fontWeight ? { fontWeight: state.fontWeight } : {}),
        },
      });
    }

    const sequence = match[0] ?? "";
    if (sequence.startsWith(`${ANSI_ESCAPE}[`) && sequence.endsWith("m")) {
      const rawCodes = sequence.slice(2, -1);
      if (/^[0-9;]*$/u.test(rawCodes)) {
        applySgrCodes(rawCodes, state);
      }
    }
    cursor = ANSI_SEQUENCE_REGEX.lastIndex;
  }

  if (cursor < line.length) {
    chunks.push({
      text: line.slice(cursor),
      style: {
        ...(state.color ? { color: state.color } : {}),
        ...(state.backgroundColor ? { backgroundColor: state.backgroundColor } : {}),
        ...(state.fontWeight ? { fontWeight: state.fontWeight } : {}),
      },
    });
  }
  return chunks;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]?.trim().length === 0) {
    start += 1;
  }
  let end = lines.length - 1;
  while (end >= start && lines[end]?.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end + 1);
}

function isLikelyLogoLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes(":") || trimmed.includes("@")) {
    return false;
  }
  const letterCount = (trimmed.match(/[A-Za-z]/gu) ?? []).length;
  const symbolCount = (trimmed.match(/[./\\+`'_-]/gu) ?? []).length;
  return letterCount >= 6 && symbolCount >= 2;
}

function parseNeofetchOutput(rawOutput: string): ParsedNeofetchOutput {
  const normalized = rawOutput.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const plainLines = lines.map((line) => stripAnsiSequences(line));
  const infoStartIndex = plainLines.findIndex((line) => /\S+@\S+/u.test(line));

  if (infoStartIndex < 0) {
    return {
      infoLines: trimBlankLines(lines).map((line) => parseAnsiLine(line)),
      logoLines: [],
    };
  }

  const logoStartAfterInfo = plainLines.findIndex(
    (line, index) => index > infoStartIndex && isLikelyLogoLine(line),
  );

  let infoRaw: string[] = [];
  let logoRaw: string[] = [];
  if (logoStartAfterInfo > infoStartIndex) {
    infoRaw = lines.slice(infoStartIndex, logoStartAfterInfo);
    logoRaw = lines.slice(logoStartAfterInfo);
  } else {
    const logoBeforeInfo = infoStartIndex > 0 ? lines.slice(0, infoStartIndex) : [];
    logoRaw = logoBeforeInfo;
    infoRaw = lines.slice(infoStartIndex);
  }

  return {
    infoLines: trimBlankLines(infoRaw).map((line) => parseAnsiLine(line)),
    logoLines: trimBlankLines(logoRaw).map((line) => parseAnsiLine(line)),
  };
}

function renderAnsiLine(chunks: AnsiChunk[], key: string): React.ReactNode {
  return (
    <div key={key} className="whitespace-pre">
      {chunks.length === 0
        ? " "
        : chunks.map((chunk, index) => (
            <span key={`${key}-${index}`} style={chunk.style}>
              {chunk.text}
            </span>
          ))}
    </div>
  );
}

export const NeofetchPanel: React.FC<NeofetchPanelProps> = ({
  output,
  onReload,
  isReloading = false,
}) => {
  const parsed = React.useMemo(() => parseNeofetchOutput(output), [output]);

  return (
    <section className="border border-term-border p-0">
      <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between items-center">
        <h2 className="text-sm font-bold uppercase tracking-wider">Host_Info</h2>
        {onReload && (
          <button
            type="button"
            onClick={onReload}
            disabled={isReloading}
            className="border border-term-border hover:bg-term-fg hover:text-black p-1.5 transition-colors disabled:opacity-50"
            title="Reload host info"
            aria-label="Reload host info"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={isReloading ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        )}
      </div>
      <div className="p-4 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6">
        {output ? (
          <>
            <div className="font-mono text-xs leading-5 text-zinc-300 overflow-x-auto">
              {parsed.infoLines.map((chunks, index) =>
                renderAnsiLine(chunks, `host-info-${index}`),
              )}
            </div>
            <div className="font-mono text-xs leading-5 text-zinc-300 overflow-x-auto lg:justify-self-end">
              {parsed.logoLines.map((chunks, index) =>
                renderAnsiLine(chunks, `host-logo-${index}`),
              )}
            </div>
          </>
        ) : (
          <div className="font-mono text-xs text-zinc-500 col-span-full">
            {isReloading ? "Fetching..." : "Click reload icon to fetch host info"}
          </div>
        )}
      </div>
    </section>
  );
};
