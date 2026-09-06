export type AudioSource = "microphone" | "tab";
export type DelayLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GlossaryEntry {
  source: string;
  target: string;
}

export interface TranscriptSegment {
  id: string;
  startedMs: number;
  source: string;
  translation: string;
  status: "partial" | "translating" | "done" | "error";
}

export interface RuntimeConfig {
  ok: boolean;
  transcriptionTransport: "realtime" | "chunked";
  configured: {
    transcription: boolean;
    translation: boolean;
    pipeline: boolean;
  };
  models: {
    transcription: string;
    translation: string;
  };
}

export interface PublicProviderConfig {
  baseUrl: string;
  model: string;
  proxyUrl: string;
  hasApiKey: boolean;
}

export interface ModelConfigResponse {
  transcription: PublicProviderConfig;
  translation: PublicProviderConfig;
}

export interface RealtimeEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: unknown;
  [key: string]: unknown;
}
