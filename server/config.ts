import "dotenv/config";

function value(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export const config = {
  port: Number(value("PORT") || 8787),
  transcription: {
    baseUrl: value("TRANSCRIPTION_API_BASE_URL").replace(/\/$/, ""),
    apiKey: value("TRANSCRIPTION_API_KEY"),
    model: value("TRANSCRIPTION_MODEL"),
    proxyUrl: value("TRANSCRIPTION_PROXY_URL").replace(/\/$/, ""),
  },
  translation: {
    baseUrl: value("TRANSLATION_API_BASE_URL").replace(/\/$/, ""),
    apiKey: value("TRANSLATION_API_KEY"),
    model: value("TRANSLATION_MODEL"),
    proxyUrl: value("TRANSLATION_PROXY_URL").replace(/\/$/, ""),
  },
};

export type ProviderName = "transcription" | "translation";
export interface ProviderInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  proxyUrl: string;
}

export function requireProvider(name: ProviderName) {
  const provider = config[name];
  const label = name === "transcription" ? "转写服务" : "翻译服务";
  const missing = [
    !provider.baseUrl && "Base URL",
    !provider.apiKey && "API Key",
    !provider.model && "Model Name",
  ].filter(Boolean);
  if (missing.length) {
    throw new ConfigError(`${label}缺少 ${missing.join("、")}，请填写 .env 后重启服务。`);
  }
  return provider;
}

export function updateProviders(next: {
  transcription: ProviderInput;
  translation: ProviderInput;
}) {
  config.transcription = { ...next.transcription };
  config.translation = { ...next.translation };
}

export function publicConfig() {
  return {
    transcription: {
      baseUrl: config.transcription.baseUrl,
      model: config.transcription.model,
      proxyUrl: config.transcription.proxyUrl,
      hasApiKey: Boolean(config.transcription.apiKey),
    },
    translation: {
      baseUrl: config.translation.baseUrl,
      model: config.translation.model,
      proxyUrl: config.translation.proxyUrl,
      hasApiKey: Boolean(config.translation.apiKey),
    },
  };
}

export function transcriptionTransport(): "realtime" | "chunked" {
  const { baseUrl, model } = config.transcription;
  return /groq\.com/i.test(baseUrl) || /^whisper(?:-|$)/i.test(model) ? "chunked" : "realtime";
}

export class ConfigError extends Error {
  status = 503;
}
