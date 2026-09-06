import type { GlossaryEntry } from "../types";

export function parseGlossary(raw: string): GlossaryEntry[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*(?:=>|->|=|：|:)\s*/, 2);
      return { source: parts[0]?.trim() ?? "", target: parts[1]?.trim() ?? "" };
    })
    .filter((entry) => entry.source && entry.target)
    .slice(0, 100);
}
