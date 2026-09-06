import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { acquireAudio, attachLevelMeter } from "./lib/audio";
import { formatChineseCaption, formatEnglishCaption } from "./lib/captions";
import { exportMarkdown, exportSrt } from "./lib/export";
import { errorMessage } from "./lib/errors";
import { parseGlossary } from "./lib/glossary";
import { startTranscription, type LiveSession } from "./lib/realtime";
import type {
  AudioSource,
  DelayLevel,
  ModelConfigResponse,
  RealtimeEvent,
  RuntimeConfig,
  TranscriptSegment,
} from "./types";

const SEGMENTS_KEY = "lecture-bridge-segments-v1";
const SETTINGS_KEY = "lecture-bridge-settings-v1";

type AppStatus = "idle" | "connecting" | "live" | "stopping" | "error";
type ProviderField = "baseUrl" | "apiKey" | "model" | "proxyUrl";
type CaptionFont = "sans" | "heiti" | "honglou" | "serif" | "mono";
type CaptionScale = number;

interface ProviderForm {
  baseUrl: string;
  apiKey: string;
  model: string;
  proxyUrl: string;
  hasApiKey: boolean;
}

interface ModelConfigForm {
  transcription: ProviderForm;
  translation: ProviderForm;
}

interface DocumentPictureInPictureController {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface SavedSettings {
  source: AudioSource;
  prompt: string;
  glossary: string;
  delay: DelayLevel;
  translationEnabled: boolean;
  captionFont: CaptionFont;
  captionSize: CaptionScale;
  translationFont: CaptionFont;
  translationSize: CaptionScale;
}

const DEFAULT_SETTINGS: SavedSettings = {
  source: "microphone",
  prompt: "An English university lecture. Preserve technical terms, names, formulas, and acronyms.",
  glossary: "",
  delay: "low",
  translationEnabled: true,
  captionFont: "sans",
  captionSize: 100,
  translationFont: "sans",
  translationSize: 100,
};

export default function App() {
  const savedSettings = useMemo(loadSettings, []);
  const [source, setSource] = useState<AudioSource>(savedSettings.source);
  const [prompt, setPrompt] = useState(savedSettings.prompt);
  const [glossary, setGlossary] = useState(savedSettings.glossary);
  const [delay, setDelay] = useState<DelayLevel>(savedSettings.delay);
  const [translationEnabled, setTranslationEnabled] = useState(savedSettings.translationEnabled);
  const [captionFont, setCaptionFont] = useState<CaptionFont>(savedSettings.captionFont);
  const [captionSize, setCaptionSize] = useState<CaptionScale>(savedSettings.captionSize);
  const [translationFont, setTranslationFont] = useState<CaptionFont>(savedSettings.translationFont);
  const [translationSize, setTranslationSize] = useState<CaptionScale>(savedSettings.translationSize);
  const [segments, setSegments] = useState<TranscriptSegment[]>(loadSegments);
  const [captionStartIndex, setCaptionStartIndex] = useState(0);
  const [pendingRecognitionCount, setPendingRecognitionCount] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [statusText, setStatusText] = useState("准备就绪");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [configOpen, setConfigOpen] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configForm, setConfigForm] = useState<ModelConfigForm>(emptyConfigForm);
  const [compactWindowOpen, setCompactWindowOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const sessionRef = useRef<LiveSession | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);
  const meterCleanupRef = useRef<(() => void) | null>(null);
  const clockRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const segmentsRef = useRef(segments);
  const translationLanesRef = useRef<Array<Promise<void>>>([Promise.resolve(), Promise.resolve()]);
  const nextTranslationLaneRef = useRef(0);
  const pendingRecognitionIdsRef = useRef(new Set<string>());
  const transcriptPanelRef = useRef<HTMLDivElement | null>(null);
  const compactWindowRef = useRef<Window | null>(null);

  const isRunning = status === "connecting" || status === "live" || status === "stopping";
  const glossaryEntries = useMemo(() => parseGlossary(glossary), [glossary]);
  const configurationReady = translationEnabled
    ? runtime?.configured.pipeline
    : runtime?.configured.transcription;

  useEffect(() => {
    void refreshRuntime().catch((cause) =>
      setError(errorMessage(cause, "无法读取服务配置")),
    );
  }, []);

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const clearInstallPrompt = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", clearInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", clearInstallPrompt);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SEGMENTS_KEY, JSON.stringify(segments));
    segmentsRef.current = segments;
    transcriptPanelRef.current?.scrollTo({ top: transcriptPanelRef.current.scrollHeight, behavior: "smooth" });
  }, [segments]);

  useEffect(() => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        source,
        prompt,
        glossary,
        delay,
        translationEnabled,
        captionFont,
        captionSize,
        translationFont,
        translationSize,
      } satisfies SavedSettings),
    );
  }, [source, prompt, glossary, delay, translationEnabled, captionFont, captionSize, translationFont, translationSize]);

  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
      sourceStreamRef.current?.getTracks().forEach((track) => track.stop());
      meterCleanupRef.current?.();
      if (clockRef.current) window.clearInterval(clockRef.current);
      compactWindowRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const compactWindow = compactWindowRef.current;
    if (!compactWindow) return;
    if (compactWindow.closed) {
      compactWindowRef.current = null;
      setCompactWindowOpen(false);
      return;
    }
    renderCompactCaptions(
      compactWindow,
      segments.slice(captionStartIndex),
      translationEnabled,
      captionFont,
      captionSize,
      translationFont,
      translationSize,
    );
  }, [segments, captionStartIndex, translationEnabled, captionFont, captionSize, translationFont, translationSize]);

  function updateSegments(updater: (current: TranscriptSegment[]) => TranscriptSegment[]) {
    const next = updater(segmentsRef.current);
    segmentsRef.current = next;
    setSegments(next);
  }

  async function refreshRuntime() {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("本地服务不可用");
    setRuntime((await response.json()) as RuntimeConfig);
  }

  async function openConfiguration() {
    setConfigError("");
    try {
      const response = await fetch("/api/config");
      const payload = (await response.json()) as ModelConfigResponse & { error?: unknown };
      if (!response.ok) throw new Error(errorMessage(payload.error, "无法读取模型配置。"));
      setConfigForm({
        transcription: { ...payload.transcription, apiKey: "" },
        translation: { ...payload.translation, apiKey: "" },
      });
      setConfigOpen(true);
    } catch (cause) {
      setError(errorMessage(cause, "无法读取模型配置。"));
    }
  }

  async function installApplication() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstallPrompt(null);
  }

  function updateConfigField(
    provider: "transcription" | "translation",
    field: ProviderField,
    value: string,
  ) {
    setConfigForm((current) => ({
      ...current,
      [provider]: { ...current[provider], [field]: value },
    }));
  }

  async function saveConfiguration(event: React.FormEvent) {
    event.preventDefault();
    setConfigSaving(true);
    setConfigError("");
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcription: {
            baseUrl: configForm.transcription.baseUrl,
            apiKey: configForm.transcription.apiKey,
            model: configForm.transcription.model,
            proxyUrl: configForm.transcription.proxyUrl,
          },
          translation: {
            baseUrl: configForm.translation.baseUrl,
            apiKey: configForm.translation.apiKey,
            model: configForm.translation.model,
            proxyUrl: configForm.translation.proxyUrl,
          },
        }),
      });
      const payload = (await response.json()) as ModelConfigResponse & { error?: unknown };
      if (!response.ok) throw new Error(errorMessage(payload.error, "保存配置失败。"));
      await refreshRuntime();
      setConfigOpen(false);
      setStatusText("模型配置已保存");
    } catch (cause) {
      setConfigError(errorMessage(cause, "保存配置失败。"));
    } finally {
      setConfigSaving(false);
    }
  }

  function ensureSegment(id: string, startedMs = currentElapsed()): TranscriptSegment {
    const existing = segmentsRef.current.find((segment) => segment.id === id);
    if (existing) return existing;
    const created: TranscriptSegment = {
      id,
      startedMs,
      source: "",
      translation: "",
      status: "partial",
    };
    updateSegments((current) => [...current, created]);
    return created;
  }

  function patchSegment(id: string, patch: Partial<TranscriptSegment>) {
    ensureSegment(id);
    updateSegments((current) =>
      current.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)),
    );
  }

  function appendSegment(id: string, field: "source" | "translation", deltaText: string) {
    ensureSegment(id);
    updateSegments((current) =>
      current.map((segment) =>
        segment.id === id ? { ...segment, [field]: segment[field] + deltaText } : segment,
      ),
    );
  }

  async function start() {
    setError("");
    if (!configurationReady) {
      setError(
        translationEnabled
          ? "中文翻译已开启，请先在模型配置中完整填写转写与翻译服务。"
          : "请先在模型配置中完整填写语音转写服务。",
      );
      return;
    }
    setStatus("connecting");
    setStatusText(source === "tab" ? "等待选择课程标签页…" : "正在请求麦克风权限…");
    setCaptionStartIndex(segmentsRef.current.length);
    pendingRecognitionIdsRef.current.clear();
    setPendingRecognitionCount(0);
    translationLanesRef.current = [Promise.resolve(), Promise.resolve()];
    nextTranslationLaneRef.current = 0;

    try {
      const stream = await acquireAudio(source);
      sourceStreamRef.current = stream;
      meterCleanupRef.current = attachLevelMeter(stream, setLevel);
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      clockRef.current = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 500);

      const onState = (connectionState: RTCPeerConnectionState) => {
        if (connectionState === "connected") {
          setStatus("live");
          setStatusText(translationEnabled ? "正在实时翻译" : "正在实时转写");
        } else if (connectionState === "failed" || connectionState === "disconnected") {
          setStatus("error");
          setStatusText("连接已中断");
          setError("实时连接中断。请停止后重新开始，并检查校园网络或热点。" );
        }
      };

      setStatusText("正在建立低延迟连接…");
      sessionRef.current = await startTranscription({
        stream,
        model: runtime?.models.transcription ?? "",
        prompt,
        keywords: glossaryEntries.map((entry) => entry.source),
        delay,
        transport: runtime?.transcriptionTransport ?? "realtime",
        onState,
        onEvent: handleTranscriptionEvent,
      });
    } catch (cause) {
      cleanupMedia();
      setStatus("error");
      setStatusText("启动失败");
      setError(errorMessage(cause, translationEnabled ? "无法启动实时翻译。" : "无法启动实时转写。"));
    }
  }

  async function stop() {
    setStatus("stopping");
    setStatusText("正在结束并接收最后字幕…");
    try {
      await sessionRef.current?.stop();
      await Promise.allSettled(translationLanesRef.current);
    } finally {
      sessionRef.current = null;
      cleanupMedia();
      setStatus("idle");
      setStatusText("已停止，字幕保存在本机浏览器中");
    }
  }

  function cleanupMedia() {
    sourceStreamRef.current?.getTracks().forEach((track) => track.stop());
    sourceStreamRef.current = null;
    meterCleanupRef.current?.();
    meterCleanupRef.current = null;
    if (clockRef.current) window.clearInterval(clockRef.current);
    clockRef.current = null;
  }

  function handleTranscriptionEvent(event: RealtimeEvent) {
    if (event.type === "lecture.audio_chunk.queued" && event.item_id) {
      pendingRecognitionIdsRef.current.add(event.item_id);
      setPendingRecognitionCount(pendingRecognitionIdsRef.current.size);
      return;
    }
    if (event.item_id && (event.type === "error" || event.type.endsWith("error") || event.type === "conversation.item.input_audio_transcription.completed")) {
      pendingRecognitionIdsRef.current.delete(event.item_id);
      setPendingRecognitionCount(pendingRecognitionIdsRef.current.size);
    }
    if (event.type === "error" || event.type.endsWith("error")) {
      setError(errorMessage(event.error, "实时转写服务返回错误。"));
      return;
    }
    const id = event.item_id || `turn-${Date.now()}`;
    if (event.type === "input_audio_buffer.speech_started") {
      ensureSegment(id);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      appendSegment(id, "source", event.delta);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const rawSourceText = (event.transcript || segmentsRef.current.find((item) => item.id === id)?.source || "").trim();
      const sourceText = formatEnglishCaption(rawSourceText);
      if (!sourceText) return;
      if (translationEnabled) {
        patchSegment(id, { source: sourceText, status: "translating" });
        enqueueTranslation(id, sourceText);
      } else {
        patchSegment(id, { source: sourceText, translation: "", status: "done" });
      }
    }
  }

  function enqueueTranslation(id: string, sourceText: string) {
    const lane = nextTranslationLaneRef.current % translationLanesRef.current.length;
    nextTranslationLaneRef.current += 1;
    translationLanesRef.current[lane] = translationLanesRef.current[lane]
      .then(async () => {
        const context = segmentsRef.current
          .filter((segment) => segment.id !== id && segment.status === "done" && segment.source.trim())
          .slice(-3)
          .map((segment) => segment.source.trim());
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceText, context, glossary: glossaryEntries }),
        });
        const payload = (await response.json()) as { translation?: string; error?: unknown };
        if (!response.ok || !payload.translation) {
          throw new Error(errorMessage(payload.error, "翻译模型没有返回结果。"));
        }
        patchSegment(id, { translation: formatChineseCaption(payload.translation), status: "done" });
      })
      .catch((cause) => {
        patchSegment(id, { status: "error" });
        setError(errorMessage(cause, "某个字幕片段翻译失败。"));
      });
  }

  function clearTranscript() {
    if (isRunning || !window.confirm("清空当前所有字幕？此操作无法撤销。")) return;
    updateSegments(() => []);
    setCaptionStartIndex(0);
    localStorage.removeItem(SEGMENTS_KEY);
  }

  function currentElapsed() {
    return startedAtRef.current ? Date.now() - startedAtRef.current : elapsedMs;
  }

  async function toggleCompactWindow() {
    const current = compactWindowRef.current;
    if (current && !current.closed) {
      current.close();
      compactWindowRef.current = null;
      setCompactWindowOpen(false);
      return;
    }

    setError("");
    try {
      const pictureInPicture = (window as Window & {
        documentPictureInPicture?: DocumentPictureInPictureController;
      }).documentPictureInPicture;
      let compactWindow: Window | null = null;
      if (pictureInPicture) {
        try {
          compactWindow = await pictureInPicture.requestWindow({ width: 720, height: 330 });
        } catch {
          // Some Chromium app-window modes expose the API but reject it; use a normal popup instead.
        }
      }
      compactWindow ??= window.open(
        "about:blank",
        "lecture-bridge-caption-window",
        "popup=yes,width=720,height=330,resizable=yes,scrollbars=no",
      );
      if (!compactWindow) throw new Error("浏览器阻止了字幕小窗，请允许此网站打开弹窗。");

      prepareCompactWindow(compactWindow);
      compactWindowRef.current = compactWindow;
      setCompactWindowOpen(true);
      renderCompactCaptions(
        compactWindow,
        segmentsRef.current.slice(captionStartIndex),
        translationEnabled,
        captionFont,
        captionSize,
        translationFont,
        translationSize,
      );

      const handleClose = () => {
        if (compactWindowRef.current !== compactWindow) return;
        compactWindowRef.current = null;
        setCompactWindowOpen(false);
      };
      compactWindow.addEventListener("pagehide", handleClose, { once: true });
      compactWindow.addEventListener("beforeunload", handleClose, { once: true });
    } catch (cause) {
      setError(errorMessage(cause, "无法打开字幕小窗。"));
    }
  }

  const focusSegments = segments
    .slice(captionStartIndex)
    .filter((segment) => segment.source || segment.translation)
    .slice(-1);
  const latest = focusSegments.at(-1);
  const focusSource = focusSegments.map((segment) => segment.source.trim()).filter(Boolean).join(" ");
  const focusTranslation = focusSegments
    .map((segment) => segment.translation.trim())
    .filter(Boolean)
    .join(" ");
  const focusTranslationPending = focusSegments.some((segment) => segment.status === "translating");

  return (
    <main
      className={`app-shell caption-font-${captionFont} translation-font-${translationFont}`}
      style={captionScaleStyle(captionSize, translationSize)}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="eyebrow">LOCAL-FIRST LIVE CAPTIONS</div>
          <h1><span>Lecture</span><span>Bridge</span></h1>
        </div>
        <div className="topbar-actions">
          {installPrompt && (
            <button className="install-button" type="button" onClick={() => void installApplication()}>
              <span aria-hidden="true">↓</span>
              安装应用
            </button>
          )}
          <button className="config-button" type="button" onClick={() => void openConfiguration()}>
            <span className="config-icon" aria-hidden="true">⌘</span>
            模型配置
          </button>
          <div className={`status-pill status-${status}`}>
            <i />
            <span>{statusText}</span>
            <strong>{formatDuration(elapsedMs)}</strong>
          </div>
        </div>
      </header>

      <section className="hero-grid">
        <aside className="control-panel">
          <div className="panel-heading">
            <span>01</span>
            <div><h2>会话设置</h2><p>API Key 始终留在本机服务端</p></div>
          </div>

          <div className="field-row">
            <label>声音来源
              <select value={source} onChange={(event) => setSource(event.target.value as AudioSource)} disabled={isRunning}>
                <option value="microphone">实体课堂 · 麦克风</option>
                <option value="tab">在线课堂 · 浏览器标签页</option>
              </select>
            </label>
            <label>延迟 / 准确度
              <select value={delay} onChange={(event) => setDelay(event.target.value as DelayLevel)} disabled={isRunning}>
                <option value="minimal">Minimal · 限流安全，最长 3.2 秒</option>
                <option value="low">Low · 自适应，最长 3.4 秒（推荐）</option>
                <option value="medium">Medium · 自适应，最长 4.5 秒</option>
                <option value="high">High · 自适应，最长 6 秒</option>
              </select>
            </label>
          </div>

          <label className="stacked-field">课程背景
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={isRunning} rows={3} placeholder="例如：A molecular biology lecture about CRISPR..." />
          </label>
          <label className="stacked-field">术语表 <small>{glossaryEntries.length} 条有效映射</small>
            <textarea value={glossary} onChange={(event) => setGlossary(event.target.value)} disabled={isRunning} rows={4} placeholder={"gradient descent = 梯度下降\nbackpropagation = 反向传播"} />
          </label>

          <label className={`translation-toggle ${translationEnabled ? "is-enabled" : ""}`}>
            <input
              type="checkbox"
              checked={translationEnabled}
              onChange={(event) => setTranslationEnabled(event.target.checked)}
              disabled={isRunning}
            />
            <span className="toggle-track" aria-hidden="true"><i /></span>
            <span className="toggle-copy">
              <b>中文 AI 翻译</b>
              <small>{translationEnabled ? "已开启 · 英文转写后生成中文字幕" : "已关闭 · 仅显示英文转写，响应更快"}</small>
            </span>
          </label>

          <div className="caption-style-controls" aria-label="字幕样式">
            <label>英文字体
              <select value={captionFont} onChange={(event) => setCaptionFont(event.target.value as CaptionFont)}>
                <option value="sans">无衬线 · 清晰</option>
                <option value="heiti">华文黑体</option>
                <option value="serif">衬线 · 宋体</option>
                <option value="mono">等宽</option>
              </select>
            </label>
            <label>英文大小
              <select value={captionSize} onChange={(event) => setCaptionSize(Number(event.target.value))}>
                <CaptionScaleOptions />
              </select>
            </label>
            <label>中文字体
              <select value={translationFont} onChange={(event) => setTranslationFont(event.target.value as CaptionFont)}>
                <option value="sans">无衬线 · 清晰</option>
                <option value="honglou">汉仪国图创新红楼梦 55U</option>
                <option value="heiti">华文黑体</option>
                <option value="serif">衬线 · 宋体</option>
                <option value="mono">等宽</option>
              </select>
            </label>
            <label>中文大小
              <select value={translationSize} onChange={(event) => setTranslationSize(Number(event.target.value))}>
                <CaptionScaleOptions />
              </select>
            </label>
          </div>

          <div className="meter-wrap">
            <span>输入电平</span>
            <div className="meter"><i style={{ width: `${Math.max(2, level * 100)}%` }} /></div>
          </div>

          {runtime && !configurationReady && (
            <div className="config-warning">
              <span>{translationEnabled ? "转写或翻译服务尚未配置。" : "转写服务尚未配置。"}</span>
              <button type="button" onClick={() => void openConfiguration()}>立即配置</button>
            </div>
          )}
          {error && <div className="error-box"><b>需要处理</b><span>{error}</span></div>}

          <div className="primary-actions">
            {!isRunning ? (
              <button className="start-button" onClick={() => void start()} disabled={!configurationReady}>
                <span>{translationEnabled ? "开始实时翻译" : "开始实时转写"}</span><kbd>LIVE</kbd>
              </button>
            ) : (
              <button className="stop-button" onClick={() => void stop()} disabled={status === "stopping"}>
                <span>停止并保存</span><i />
              </button>
            )}
            {!isRunning && segments.some((segment) => segment.source || segment.translation) && (
              <button className="export-session-button" type="button" onClick={() => exportMarkdown(segments)}>
                <span>导出本次字幕</span><small>MARKDOWN .MD</small>
              </button>
            )}
          </div>
        </aside>

        <section className="caption-stage">
          <div className="stage-toolbar">
            <div><span className="stage-index">02</span><b>实时字幕</b></div>
            <div className="toolbar-actions">
              <button
                className={compactWindowOpen ? "is-active" : ""}
                onClick={() => void toggleCompactWindow()}
              >
                {compactWindowOpen ? "关闭小窗" : "字幕小窗"}
              </button>
              <button onClick={() => exportMarkdown(segments)} disabled={!segments.length}>Markdown</button>
              <button onClick={() => exportSrt(segments)} disabled={!segments.length}>SRT</button>
              <button onClick={clearTranscript} disabled={!segments.length || isRunning}>清空</button>
            </div>
          </div>

          <div className={`focus-caption ${latest || pendingRecognitionCount ? "has-caption" : "is-empty"}`}>
            <span
              className={`caption-pending caption-pending-fixed ${pendingRecognitionCount > 0 ? "" : "is-hidden"}`}
              aria-live="polite"
              aria-hidden={pendingRecognitionCount === 0}
            >
              正在识别下一句
            </span>
            {latest ? (
              <div className="subtitle-overlay" aria-live="polite">
                <p className={`focus-source ${translationEnabled ? "" : "is-primary"}`}>
                  {focusSource || "正在聆听…"}
                </p>
                {translationEnabled && (
                  <p className={`focus-translation ${latest.status === "partial" ? "is-partial" : ""}`}>
                    {focusTranslation || (focusTranslationPending ? "正在翻译…" : "…")}
                  </p>
                )}
              </div>
            ) : pendingRecognitionCount > 0 ? null : (
              <div className="empty-focus">
                <div className="sound-mark"><i /><i /><i /><i /><i /></div>
                <h3>{translationEnabled ? "让课堂语言不再成为障碍" : "快速捕捉每一句英文"}</h3>
                <p>{translationEnabled ? "选择声音来源，然后开始。确定字幕会自动保存在浏览器中。" : "当前仅开启英文转写，不会调用翻译模型。"}</p>
              </div>
            )}
          </div>

          <div className="transcript-panel" ref={transcriptPanelRef}>
            <div className="transcript-heading"><span>课堂记录</span><small>{segments.filter((item) => item.source || item.translation).length} 个片段</small></div>
            {segments.filter((item) => item.source || item.translation).length === 0 ? (
              <p className="empty-history">暂无字幕记录</p>
            ) : (
              segments.filter((item) => item.source || item.translation).map((segment) => (
                <article className={`transcript-row row-${segment.status}`} key={segment.id}>
                  <time>{formatDuration(segment.startedMs)}</time>
                  <div>
                    {segment.source && <p className="row-source">{segment.source}</p>}
                    {segment.translation && <p className="row-translation">{segment.translation}</p>}
                    {segment.status === "translating" && <span className="working">翻译中</span>}
                    {segment.status === "error" && <span className="failed">翻译失败</span>}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </section>

      <footer>
        <span>LECTURE BRIDGE / LOCAL SESSION</span>
        <span>音频不在本机保存 · 字幕保存在浏览器 LocalStorage</span>
      </footer>

      {configOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !configSaving) setConfigOpen(false);
        }}>
          <form className="config-dialog" onSubmit={(event) => void saveConfiguration(event)}>
            <div className="dialog-heading">
              <div>
                <span className="dialog-kicker">LOCAL MODEL ROUTING</span>
                <h2>模型配置</h2>
                <p>两套服务独立连接。API Key 只写入本机的 .env，不会回显到网页。</p>
              </div>
              <button type="button" className="dialog-close" onClick={() => setConfigOpen(false)} disabled={configSaving} aria-label="关闭">×</button>
            </div>

            <div className="provider-grid">
              <ProviderFields
                index="01"
                title="实时语音转写"
                hint="自动兼容 Realtime 或 Whisper 文件转写"
                value={configForm.transcription}
                onChange={(field, value) => updateConfigField("transcription", field, value)}
              />
              <ProviderFields
                index="02"
                title="文本翻译"
                hint="兼容 Chat Completions · 自动适配 TranslateGemma"
                value={configForm.translation}
                onChange={(field, value) => updateConfigField("translation", field, value)}
              />
            </div>

            {configError && <div className="dialog-error">{configError}</div>}
            <div className="dialog-actions">
              <button type="button" className="cancel-button" onClick={() => setConfigOpen(false)} disabled={configSaving}>取消</button>
              <button type="submit" className="save-button" disabled={configSaving}>{configSaving ? "正在保存…" : "保存并立即生效"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function prepareCompactWindow(compactWindow: Window): void {
  const { document } = compactWindow;
  document.documentElement.lang = "zh-CN";
  document.title = "Lecture Bridge 字幕小窗";

  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width,initial-scale=1";
  const style = document.createElement("style");
  style.textContent = `
    :root { color-scheme: dark; font-family: "Noto Sans SC", system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #0b0e0c; }
    body { color: #f4f6f2; background: radial-gradient(circle at 50% 0, #252c26, #0b0e0c 68%); }
    @font-face { font-family: "Lecture Bridge HongLouMeng"; src: url("/fonts/HYGuoTuChuangXinHongLouMeng-55U.ttf") format("truetype"); font-style: normal; font-weight: 400; font-display: swap; }
    #compact-caption-root { --compact-source-font: "Noto Sans SC", system-ui, -apple-system, sans-serif; --compact-translation-font: "Noto Sans SC", system-ui, -apple-system, sans-serif; --compact-translation-weight: 750; --compact-translation-spacing: -.02em; --compact-source-size: clamp(12px, 2.6vw, 17px); --compact-primary-size: clamp(18px, 4.3vw, 29px); --compact-translation-size: clamp(19px, 4.5vw, 30px); height: 100%; display: grid; align-content: end; gap: 10px; padding: clamp(14px, 4vw, 28px); }
    #compact-caption-root.compact-source-font-serif { --compact-source-font: "Songti SC", STSong, "Noto Serif SC", Georgia, serif; }
    #compact-caption-root.compact-source-font-heiti { --compact-source-font: STHeiti, "STHeitiSC-Light", "Heiti SC", "华文黑体", sans-serif; }
    #compact-caption-root.compact-source-font-honglou { --compact-source-font: "Lecture Bridge HongLouMeng", "汉仪国图创新红楼梦 55U", serif; }
    #compact-caption-root.compact-source-font-mono { --compact-source-font: "SFMono-Regular", Menlo, Monaco, "Noto Sans Mono CJK SC", monospace; }
    #compact-caption-root.compact-translation-font-serif { --compact-translation-font: "Songti SC", STSong, "Noto Serif SC", Georgia, serif; }
    #compact-caption-root.compact-translation-font-heiti { --compact-translation-font: STHeiti, "STHeitiSC-Light", "Heiti SC", "华文黑体", sans-serif; }
    #compact-caption-root.compact-translation-font-honglou { --compact-translation-font: "Lecture Bridge HongLouMeng", "汉仪国图创新红楼梦 55U", serif; --compact-translation-weight: 400; --compact-translation-spacing: 0; }
    #compact-caption-root.compact-translation-font-mono { --compact-translation-font: "SFMono-Regular", Menlo, Monaco, "Noto Sans Mono CJK SC", monospace; }
    .compact-empty { place-self: center; color: #879087; font-size: 14px; }
    .compact-segment { min-width: 0; padding: 10px 14px 11px; border-radius: 7px; background: rgba(0,0,0,.74); box-shadow: 0 4px 18px rgba(0,0,0,.24); }
    .compact-segment.is-previous { opacity: .48; }
    .compact-segment p { margin: 0; white-space: pre-line; overflow-wrap: anywhere; text-wrap: balance; text-align: center; }
    .compact-source { color: #c8cec8; font-family: var(--compact-source-font); font-size: var(--compact-source-size); line-height: 1.4; }
    .compact-source.is-primary { color: #fff; font-size: var(--compact-primary-size); font-weight: 700; }
    .compact-translation { margin-top: 5px !important; color: #fff; font-family: var(--compact-translation-font); font-size: var(--compact-translation-size); font-weight: var(--compact-translation-weight); line-height: 1.38; letter-spacing: var(--compact-translation-spacing); }
    .compact-translating { color: #909990; font-size: clamp(14px, 3vw, 18px); }
  `;
  document.head.replaceChildren(viewport, style);

  const root = document.createElement("main");
  root.id = "compact-caption-root";
  root.setAttribute("aria-live", "polite");
  document.body.replaceChildren(root);
}

function renderCompactCaptions(
  compactWindow: Window,
  segments: TranscriptSegment[],
  translationEnabled: boolean,
  captionFont: CaptionFont,
  captionSize: CaptionScale,
  translationFont: CaptionFont,
  translationSize: CaptionScale,
): void {
  const { document } = compactWindow;
  let root = document.getElementById("compact-caption-root");
  if (!root) {
    prepareCompactWindow(compactWindow);
    root = document.getElementById("compact-caption-root")!;
  }
  root.className = `compact-source-font-${captionFont} compact-translation-font-${translationFont}`;
  root.style.setProperty("--compact-source-size", scaledClamp(12, 2.6, 17, captionSize));
  root.style.setProperty("--compact-primary-size", scaledClamp(18, 4.3, 29, captionSize));
  root.style.setProperty("--compact-translation-size", scaledClamp(19, 4.5, 30, translationSize));
  root.replaceChildren();

  const visible = segments
    .filter((segment) => segment.source.trim() || segment.translation.trim())
    .slice(-2);
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "compact-empty";
    empty.textContent = "正在聆听…";
    root.append(empty);
    return;
  }

  visible.forEach((segment, index) => {
    const article = document.createElement("article");
    article.className = `compact-segment ${index < visible.length - 1 ? "is-previous" : "is-current"}`;

    if (segment.source.trim()) {
      const source = document.createElement("p");
      source.className = `compact-source ${translationEnabled ? "" : "is-primary"}`.trim();
      source.textContent = segment.source.trim();
      article.append(source);
    }
    if (translationEnabled && segment.translation.trim()) {
      const translation = document.createElement("p");
      translation.className = "compact-translation";
      translation.textContent = segment.translation.trim();
      article.append(translation);
    } else if (translationEnabled && segment.status === "translating") {
      const translating = document.createElement("p");
      translating.className = "compact-translation compact-translating";
      translating.textContent = "正在翻译…";
      article.append(translating);
    }
    root.append(article);
  });
}

function ProviderFields({
  index,
  title,
  hint,
  value,
  onChange,
}: {
  index: string;
  title: string;
  hint: string;
  value: ProviderForm;
  onChange: (field: ProviderField, value: string) => void;
}) {
  return (
    <section className="provider-card">
      <div className="provider-heading">
        <span>{index}</span>
        <div><h3>{title}</h3><p>{hint}</p></div>
      </div>
      <label>Base URL
        <input type="url" required value={value.baseUrl} onChange={(event) => onChange("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} />
      </label>
      <label>API Key
        <input type="password" required={!value.hasApiKey} value={value.apiKey} onChange={(event) => onChange("apiKey", event.target.value)} placeholder={value.hasApiKey ? "已保存 · 留空保持不变" : "输入 API Key"} autoComplete="new-password" spellCheck={false} />
      </label>
      <label>Model Name
        <input type="text" required value={value.model} onChange={(event) => onChange("model", event.target.value)} placeholder="填写供应商提供的模型名称" spellCheck={false} />
      </label>
      <label>Proxy URL <small>可选</small>
        <input type="url" value={value.proxyUrl} onChange={(event) => onChange("proxyUrl", event.target.value)} placeholder="例如：http://127.0.0.1:7897" spellCheck={false} />
      </label>
    </section>
  );
}

function CaptionScaleOptions() {
  return (
    <>
      <option value={75}>75%</option>
      <option value={90}>90%</option>
      <option value={100}>100% · 标准</option>
      <option value={110}>110%</option>
      <option value={125}>125%</option>
      <option value={150}>150%</option>
      <option value={175}>175%</option>
      <option value={200}>200%</option>
    </>
  );
}

function captionScaleStyle(sourceScale: CaptionScale, translationScale: CaptionScale): CSSProperties {
  return {
    "--caption-source-size": scaledClamp(13, 1.25, 17, sourceScale),
    "--caption-primary-size": scaledClamp(20, 2.35, 31, sourceScale),
    "--caption-translation-size": scaledClamp(20, 2.45, 33, translationScale),
    "--caption-history-translation-size": `${roundScale(17 * translationScale / 100)}px`,
  } as CSSProperties;
}

function scaledClamp(minPx: number, fluidVw: number, maxPx: number, scale: CaptionScale): string {
  const factor = scale / 100;
  return `clamp(${roundScale(minPx * factor)}px, ${roundScale(fluidVw * factor)}vw, ${roundScale(maxPx * factor)}px)`;
}

function roundScale(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function loadSettings(): SavedSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as Partial<SavedSettings> | null;
    const captionFont = normalizeCaptionFont(saved?.captionFont, DEFAULT_SETTINGS.captionFont);
    const captionSize = normalizeCaptionScale(saved?.captionSize, DEFAULT_SETTINGS.captionSize);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      captionFont,
      captionSize,
      translationFont: normalizeCaptionFont(saved?.translationFont, captionFont),
      translationSize: normalizeCaptionScale(saved?.translationSize ?? saved?.captionSize, captionSize),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function normalizeCaptionFont(value: unknown, fallback: CaptionFont): CaptionFont {
  if (value === "hanyi") return "honglou";
  if (value === "sans" || value === "heiti" || value === "honglou" || value === "serif" || value === "mono") {
    return value;
  }
  return fallback;
}

function normalizeCaptionScale(value: unknown, fallback: CaptionScale): CaptionScale {
  const legacy: Record<string, CaptionScale> = {
    small: 75,
    standard: 100,
    large: 125,
    xlarge: 150,
  };
  if (typeof value === "string" && value in legacy) return legacy[value];
  const numeric = typeof value === "number" ? value : Number(value);
  const options = [75, 90, 100, 110, 125, 150, 175, 200];
  return options.includes(numeric) ? numeric : fallback;
}

function loadSegments(): TranscriptSegment[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SEGMENTS_KEY) || "[]") as unknown;
    return Array.isArray(saved) ? (saved as TranscriptSegment[]) : [];
  } catch {
    return [];
  }
}

function emptyConfigForm(): ModelConfigForm {
  const provider = (): ProviderForm => ({ baseUrl: "", apiKey: "", model: "", proxyUrl: "", hasApiKey: false });
  return { transcription: provider(), translation: provider() };
}
