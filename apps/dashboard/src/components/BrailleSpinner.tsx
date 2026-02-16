import React, { useEffect, useRef, useMemo } from "react";

/** Braille dot positions: [row0,col0], [row1,col1], ... for 2x4 Braille cell */
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function genPendulum(width: number, maxSpread: number): string[] {
  const totalFrames = 120;
  const pixelCols = width * 2;
  const frames: string[] = [];
  for (let t = 0; t < totalFrames; t++) {
    const codes = Array.from({ length: width }, () => 0x2800);
    const progress = t / totalFrames;
    const spread = Math.sin(Math.PI * progress) * maxSpread;
    const basePhase = progress * Math.PI * 8;
    for (let pc = 0; pc < pixelCols; pc++) {
      const swing = Math.sin(basePhase + pc * spread);
      const center = (1 - swing) * 1.5;
      for (let row = 0; row < 4; row++) {
        if (Math.abs(row - center) < 0.7) {
          codes[Math.floor(pc / 2)] |= DOT_BITS[row][pc % 2];
        }
      }
    }
    frames.push(codes.map((c) => String.fromCharCode(c)).join(""));
  }
  return frames;
}

function genCompress(width: number): string[] {
  const totalFrames = 100;
  const pixelCols = width * 2;
  const totalDots = pixelCols * 4;
  const frames: string[] = [];
  const rand = seededRandom(42);
  const importance: number[] = [];
  for (let i = 0; i < totalDots; i++) importance.push(rand());
  for (let t = 0; t < totalFrames; t++) {
    const codes = Array.from({ length: width }, () => 0x2800);
    const progress = t / totalFrames;
    const sieveThreshold = Math.max(0.1, 1 - progress * 1.2);
    const squeeze = Math.min(1, progress / 0.85);
    const activeWidth = Math.max(1, pixelCols * (1 - squeeze * 0.95));
    for (let pc = 0; pc < pixelCols; pc++) {
      const mappedPc = (pc / pixelCols) * activeWidth;
      if (mappedPc >= activeWidth) continue;
      const targetPc = Math.round(mappedPc);
      if (targetPc >= pixelCols) continue;
      const charIdx = Math.floor(targetPc / 2);
      const dc = targetPc % 2;
      for (let row = 0; row < 4; row++) {
        if (importance[pc * 4 + row] < sieveThreshold) {
          codes[charIdx] |= DOT_BITS[row][dc];
        }
      }
    }
    frames.push(codes.map((c) => String.fromCharCode(c)).join(""));
  }
  return frames;
}

function genSort(width: number): string[] {
  const pixelCols = width * 2;
  const totalFrames = 100;
  const frames: string[] = [];
  const rand = seededRandom(19);
  const shuffled: number[] = [];
  const target: number[] = [];
  for (let i = 0; i < pixelCols; i++) {
    shuffled.push(rand() * 3);
    target.push((i / (pixelCols - 1)) * 3);
  }
  for (let t = 0; t < totalFrames; t++) {
    const codes = Array.from({ length: width }, () => 0x2800);
    const progress = t / totalFrames;
    const cursor = progress * pixelCols * 1.2;
    for (let pc = 0; pc < pixelCols; pc++) {
      const charIdx = Math.floor(pc / 2);
      const dc = pc % 2;
      const d = pc - cursor;
      let center: number;
      if (d < -3) {
        center = target[pc];
      } else if (d < 2) {
        const blend = 1 - (d + 3) / 5;
        const ease = blend * blend * (3 - 2 * blend);
        center = shuffled[pc] + (target[pc] - shuffled[pc]) * ease;
        if (Math.abs(d) < 0.8) {
          for (let r = 0; r < 4; r++) codes[charIdx] |= DOT_BITS[r][dc];
          continue;
        }
      } else {
        center =
          shuffled[pc] +
          Math.sin(progress * Math.PI * 16 + pc * 2.7) * 0.6 +
          Math.sin(progress * Math.PI * 9 + pc * 1.3) * 0.4;
      }
      center = Math.max(0, Math.min(3, center));
      for (let r = 0; r < 4; r++) {
        if (Math.abs(r - center) < 0.7) codes[charIdx] |= DOT_BITS[r][dc];
      }
    }
    frames.push(codes.map((c) => String.fromCharCode(c)).join(""));
  }
  return frames;
}

export type BrailleSpinnerVariant = "pendulum" | "compress" | "sort";

const FRAME_GENERATORS: Record<
  BrailleSpinnerVariant,
  (width: number, maxSpread?: number) => string[]
> = {
  pendulum: (w, max = 1) => genPendulum(w, max),
  compress: (w) => genCompress(w),
  sort: (w) => genSort(w),
};

const INTERVALS: Record<BrailleSpinnerVariant, number> = {
  pendulum: 12,
  compress: 40,
  sort: 40,
};

const COLOR_CLASSES: Record<BrailleSpinnerVariant, string> = {
  pendulum: "text-term-tiger",
  compress: "text-red-400",
  sort: "text-zinc-400",
};

type BrailleSpinnerProps = {
  variant: BrailleSpinnerVariant;
  width?: number;
  className?: string;
};

/**
 * Braille-character animated spinners.
 * - pendulum: primary/initiating actions (e.g. EXECUTE RUN, Start)
 * - compress: finishing/destructive actions (e.g. Stop, Clear)
 * - sort: neutral loading (e.g. Apply, Refresh)
 */
export const BrailleSpinner: React.FC<BrailleSpinnerProps> = ({
  variant,
  width = 10,
  className = "",
}) => {
  const elRef = useRef<HTMLSpanElement>(null);
  const frames = useMemo(
    () => FRAME_GENERATORS[variant](width, variant === "pendulum" ? 1 : undefined),
    [variant, width],
  );
  const interval = INTERVALS[variant];
  const colorClass = COLOR_CLASSES[variant];
  const inheritColorToken = "[color:inherit]";
  const shouldInheritColor = className.includes(inheritColorToken);
  const normalizedClassName = className.replace(inheritColorToken, "").trim();

  useEffect(() => {
    const el = elRef.current;
    if (!el || frames.length === 0) return;
    el.textContent = frames[0];
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % frames.length;
      el.textContent = frames[i];
    }, interval);
    return () => clearInterval(id);
  }, [frames, interval]);

  return (
    <span
      ref={elRef}
      className={`inline-block tabular-nums align-middle ${colorClass} ${normalizedClassName}`}
      // Tailwind 任意値クラスに依存せず、読み込み色の継承を常に確実にする。
      style={{ fontFamily: "sans-serif", ...(shouldInheritColor ? { color: "inherit" } : {}) }}
      aria-hidden
    >
      {frames[0] ?? ""}
    </span>
  );
};
