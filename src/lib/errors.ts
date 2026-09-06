export function errorMessage(value: unknown, fallback: string): string {
  const result = extractMessage(value, new Set(), 0);
  return result && result !== "[object Object]" ? result.slice(0, 2_000) : fallback;
}

function extractMessage(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    try {
      return extractMessage(JSON.parse(text), seen, depth + 1) || text;
    } catch {
      return text;
    }
  }
  if (value instanceof Error) {
    if (seen.has(value)) return "";
    seen.add(value);
    const record = value as Error & { cause?: unknown; code?: unknown };
    const message = extractMessage(record.message, seen, depth + 1);
    const cause = extractMessage(record.cause, seen, depth + 1);
    const combined = [message, cause && cause !== message ? cause : ""].filter(Boolean).join(": ");
    const code = typeof record.code === "string" ? record.code.trim() : "";
    return code && !combined.includes(code) ? `${combined} (${code})` : combined;
  }
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "reason", "description"]) {
    const nested = extractMessage(record[key], seen, depth + 1);
    if (nested) {
      const code = typeof record.code === "string" ? record.code.trim() : "";
      return code && !nested.includes(code) ? `${nested} (${code})` : nested;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
