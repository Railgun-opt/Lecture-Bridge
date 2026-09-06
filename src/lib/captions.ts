const ENGLISH_LINE_LENGTH = 56;
const CHINESE_LINE_LENGTH = 26;

export function formatEnglishCaption(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  const sentences = segmentEnglishSentences(normalized);
  const lines: string[] = [];
  for (const sentence of sentences) {
    const units = sentence.split(/(?<=[,;:])\s+/).map((part) => part.trim()).filter(Boolean);
    const sentenceLines = packCaptionUnits(units, ENGLISH_LINE_LENGTH, splitEnglishUnit);
    if (sentenceLines.length === 1 && lines.length) {
      const combined = `${lines.at(-1)} ${sentenceLines[0]}`;
      if (combined.length <= ENGLISH_LINE_LENGTH) {
        lines[lines.length - 1] = combined;
        continue;
      }
    }
    lines.push(...sentenceLines);
  }
  return lines.join("\n");
}

export function formatChineseCaption(text: string): string {
  const normalized = text.replace(/[ \t]*\n+[ \t]*/g, "").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return "";

  const units = normalized.match(/[^，。！？；：,.!?;:]+[，。！？；：,.!?;:]*/g) ?? [normalized];
  return packCaptionUnits(units, CHINESE_LINE_LENGTH, splitChineseUnit).join("\n");
}

function segmentEnglishSentences(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(text), ({ segment }) =>
      segment.trim(),
    ).filter(Boolean);
  }
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((part) => part.trim()).filter(Boolean);
}

function packCaptionUnits(
  units: string[],
  maxLength: number,
  splitLongUnit: (unit: string, maxLength: number) => string[],
): string[] {
  const lines: string[] = [];
  let current = "";

  for (const originalUnit of units) {
    for (const unit of splitLongUnit(originalUnit, maxLength)) {
      const separator = needsSpace(current, unit) ? " " : "";
      const candidate = `${current}${separator}${unit}`;
      if (!current || candidate.length <= maxLength) {
        current = candidate;
      } else {
        lines.push(current);
        current = unit;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitEnglishUnit(unit: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = unit.trim();
  while (remaining.length > maxLength) {
    const splitAt = balancedEnglishBoundary(remaining, maxLength);
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function splitChineseUnit(unit: string, maxLength: number): string[] {
  const parts: string[] = [];
  const lineCount = Math.ceil(unit.length / maxLength);
  const balancedLength = Math.ceil(unit.length / lineCount);
  for (let offset = 0; offset < unit.length; offset += balancedLength) {
    parts.push(unit.slice(offset, offset + balancedLength));
  }
  return parts;
}

function balancedEnglishBoundary(text: string, maxLength: number): number {
  if (text.length <= maxLength * 2) {
    const ideal = text.length / 2;
    const candidates = Array.from(text.matchAll(/\s+/g), (match) => match.index)
      .filter((index) => index > 0 && index <= maxLength && text.length - index - 1 <= maxLength);
    if (candidates.length) {
      return candidates.reduce((best, index) =>
        Math.abs(index - ideal) < Math.abs(best - ideal) ? index : best,
      );
    }
  }

  const boundary = text.slice(0, maxLength + 1).lastIndexOf(" ");
  return boundary >= Math.floor(maxLength * 0.55) ? boundary : maxLength;
}

function needsSpace(left: string, right: string): boolean {
  return Boolean(left && right && /[\x00-\x7f]$/.test(left) && /^[\x00-\x7f]/.test(right));
}
