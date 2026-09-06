import type { config } from "./config.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

type ProviderConfig = (typeof config)["transcription"];
type ProxyRequestInit = RequestInit & { dispatcher?: ProxyAgent };
const providerFetch = undiciFetch as unknown as (
  input: string | URL,
  init?: ProxyRequestInit,
) => Promise<Response>;
const proxyAgents = new Map<string, ProxyAgent>();

export async function providerRequest(
  provider: ProviderConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = apiUrl(provider.baseUrl, path);
  if (!provider.proxyUrl) return providerFetch(url, requestInit(provider, init));

  try {
    return await providerFetch(url, requestInit(provider, init, proxyAgent(provider.proxyUrl)));
  } catch (error) {
    if (!isRetryableProxyError(error, init.signal)) throw error;

    // A local VPN/proxy can be restarted while Lecture Bridge is open. Drop the
    // old connection pool and retry once with a new CONNECT tunnel.
    await resetProxyAgent(provider.proxyUrl);
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      return await providerFetch(url, requestInit(provider, init, proxyAgent(provider.proxyUrl)));
    } catch (retryError) {
      throw new Error(`通过代理 ${provider.proxyUrl} 连接模型供应商失败`, { cause: retryError });
    }
  }
}

function requestInit(
  provider: ProviderConfig,
  init: RequestInit,
  dispatcher?: ProxyAgent,
): ProxyRequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(30_000),
    ...(dispatcher ? { dispatcher } : {}),
  };
}

function proxyAgent(proxyUrl: string): ProxyAgent {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const created = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, created);
  return created;
}

async function resetProxyAgent(proxyUrl: string): Promise<void> {
  const existing = proxyAgents.get(proxyUrl);
  proxyAgents.delete(proxyUrl);
  if (existing) await existing.destroy().catch(() => undefined);
}

function isRetryableProxyError(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  return error instanceof TypeError || Boolean(findErrorCode(error));
}

function findErrorCode(value: unknown, depth = 0): string {
  if (depth > 5 || !value || typeof value !== "object") return "";
  const record = value as { code?: unknown; cause?: unknown };
  if (typeof record.code === "string") return record.code;
  return findErrorCode(record.cause, depth + 1);
}

function apiUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (baseUrl.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    return `${baseUrl}${normalizedPath.slice(3)}`;
  }
  return `${baseUrl}${normalizedPath}`;
}

export async function readableAPIError(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    return formatUnknownError(JSON.parse(raw), raw || `${response.status} ${response.statusText}`);
  } catch {
    return raw || `${response.status} ${response.statusText}`;
  }
}

export function providerErrorMessage(
  provider: ProviderConfig,
  response: Response,
  detail: string,
): string {
  if (response.status === 403 && /groq\.com/i.test(provider.baseUrl)) {
    return [
      "Groq 拒绝访问（HTTP 403）。当前 API Key 所属项目或组织没有 API 权限，或请求受到地区/网络策略限制。",
      "请在 Groq Console 检查 Organization → Limits、Project → Limits，并确认当前项目允许 whisper-large-v3-turbo；也可以重新创建该项目的 API Key。",
      detail && detail.toLowerCase() !== "forbidden" ? `供应商信息：${detail}` : "",
    ].filter(Boolean).join(" ");
  }
  if (response.status === 401) {
    return `API Key 无效或已失效（HTTP 401）。${detail && detail !== "Unauthorized" ? ` ${detail}` : ""}`.trim();
  }
  if (response.status === 403) {
    return `模型供应商拒绝访问（HTTP 403），请检查 Key、项目权限与地区/网络限制。${detail && detail.toLowerCase() !== "forbidden" ? ` ${detail}` : ""}`.trim();
  }
  return detail;
}

export function formatUnknownError(value: unknown, fallback: string): string {
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

export function extractChatCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const response = payload as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((item) => item.text ?? "").join("\n").trim();
}
