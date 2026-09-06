import type { DelayLevel, RealtimeEvent } from "../types";
import { errorMessage } from "./errors";

export interface LiveSession {
  stop: () => Promise<void>;
}

interface SharedOptions {
  stream: MediaStream;
  onEvent: (event: RealtimeEvent) => void;
  onState: (state: RTCPeerConnectionState) => void;
}

interface TranscriptionOptions extends SharedOptions {
  model: string;
  prompt: string;
  keywords: string[];
  delay: DelayLevel;
  transport: "realtime" | "chunked";
}

export async function startTranscription(options: TranscriptionOptions): Promise<LiveSession> {
  if (options.transport === "chunked") return startChunkedTranscription(options);

  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel("oai-events");
  pc.onconnectionstatechange = () => options.onState(pc.connectionState);
  channel.onmessage = ({ data }) => deliverEvent(data, options.onEvent);
  channel.onopen = () => {
    channel.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              transcription: {
                model: options.model,
                prompt: options.prompt || undefined,
                keywords: options.keywords.length ? options.keywords : undefined,
                languages: ["en"],
                delay: options.delay,
              },
              noise_reduction: { type: "far_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 650,
              },
            },
          },
        },
      }),
    );
  };
  for (const track of options.stream.getAudioTracks()) pc.addTrack(track, options.stream);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch("/api/realtime/transcription-call", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    const answer = await response.text();
    if (!response.ok) {
      let errorPayload: unknown = answer;
      try {
        errorPayload = JSON.parse(answer);
      } catch {
        // Keep the raw response.
      }
      throw new Error(errorMessage(errorPayload, `实时转写 WebRTC 握手失败（HTTP ${response.status}）。`));
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    pc.close();
    throw error;
  }

  return {
    stop: async () => {
      channel.close();
      pc.close();
    },
  };
}

async function startChunkedTranscription(options: TranscriptionOptions): Promise<LiveSession> {
  try {
    return await startPcmChunkedTranscription(options);
  } catch (error) {
    console.warn("PCM/VAD capture unavailable; falling back to MediaRecorder.", error);
    return startMediaRecorderTranscription(options);
  }
}

async function startPcmChunkedTranscription(options: TranscriptionOptions): Promise<LiveSession> {
  if (!("AudioWorkletNode" in window)) throw new Error("AudioWorklet is unavailable");

  const targetSampleRate = 16_000;
  const frameSize = 320;
  const profile = vadProfile(options.delay);
  const sessionId = crypto.randomUUID();
  const uploader = createOrderedUploader(options, sessionId);
  const context = new AudioContext({ latencyHint: "interactive" });
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: AudioWorkletNode | null = null;
  let silentGain: GainNode | null = null;
  let stopped = false;
  let active = false;
  let speechMs = 0;
  let silenceMs = 0;
  let freshMs = 0;
  let noiseFloor = 0.003;
  let preRoll: Int16Array[] = [];
  let chunkFrames: Int16Array[] = [];

  const resetCapture = () => {
    active = false;
    speechMs = 0;
    silenceMs = 0;
    freshMs = 0;
    chunkFrames = [];
  };

  const flushChunk = (keepOverlap: boolean) => {
    const shouldUpload = speechMs >= 100 && chunkFrames.length > 0;
    if (shouldUpload) uploader.enqueue(wavBlob(joinFrames(chunkFrames), targetSampleRate));

    if (keepOverlap && shouldUpload) {
      const overlapFrames = Math.ceil(profile.overlapMs / frameDurationMs(frameSize, targetSampleRate));
      chunkFrames = chunkFrames.slice(-overlapFrames);
      active = true;
    } else {
      chunkFrames = [];
      active = false;
    }
    speechMs = 0;
    silenceMs = 0;
    freshMs = 0;
    preRoll = [];
  };

  const receiveFrame = (frame: Int16Array) => {
    const duration = frameDurationMs(frame.length, targetSampleRate);
    const level = pcmRms(frame);
    const voiceThreshold = Math.max(0.0045, noiseFloor * 2);
    const voiced = level >= voiceThreshold;

    if (!active) {
      if (!voiced) noiseFloor = Math.min(0.04, noiseFloor * 0.94 + level * 0.06);
      preRoll.push(frame);
      const maxPreRollFrames = Math.ceil(profile.preRollMs / duration);
      if (preRoll.length > maxPreRollFrames) preRoll.shift();
      if (!voiced) return;

      active = true;
      chunkFrames = preRoll;
      preRoll = [];
      speechMs = duration;
      freshMs = duration;
      silenceMs = 0;
      return;
    }

    chunkFrames.push(frame);
    freshMs += duration;
    if (voiced) {
      speechMs += duration;
      silenceMs = 0;
    } else {
      silenceMs += duration;
    }

    if (silenceMs >= profile.silenceMs && speechMs < profile.minSpeechMs) {
      resetCapture();
      return;
    }
    if (
      silenceMs >= profile.silenceMs &&
      speechMs >= profile.minSpeechMs &&
      freshMs >= profile.minChunkMs
    ) {
      flushChunk(false);
      return;
    }
    if (freshMs >= profile.maxChunkMs) flushChunk(true);
  };

  try {
    await context.audioWorklet.addModule("/pcm-capture-worklet.js");
    source = context.createMediaStreamSource(new MediaStream(options.stream.getAudioTracks()));
    processor = new AudioWorkletNode(context, "lecture-pcm-capture", {
      processorOptions: { targetSampleRate, frameSize },
    });
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!stopped) receiveFrame(new Int16Array(event.data));
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    await context.resume();
  } catch (error) {
    source?.disconnect();
    processor?.disconnect();
    silentGain?.disconnect();
    await context.close().catch(() => undefined);
    throw error;
  }

  options.onState("connected");
  return {
    stop: async () => {
      if (stopped) {
        await uploader.waitForIdle();
        return;
      }
      stopped = true;
      processor!.port.onmessage = null;
      source!.disconnect();
      processor!.disconnect();
      silentGain!.disconnect();
      flushChunk(false);
      await context.close().catch(() => undefined);
      await uploader.waitForIdle();
    },
  };
}

function startMediaRecorderTranscription(options: TranscriptionOptions): LiveSession {
  const mimeType = supportedRecordingType();
  const sessionId = crypto.randomUUID();
  const uploader = createOrderedUploader(options, sessionId);
  let activeRecorder: MediaRecorder | null = null;
  let cycleTimer: number | null = null;
  let stopped = false;
  let stopResolver: (() => void) | null = null;

  const finishIfStopped = async () => {
    if (!stopped || activeRecorder || !stopResolver) return;
    const resolve = stopResolver;
    stopResolver = null;
    await uploader.waitForIdle();
    resolve();
  };

  const runCycle = () => {
    if (stopped) {
      void finishIfStopped();
      return;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(options.stream, {
      mimeType,
      audioBitsPerSecond: 48_000,
    });
    activeRecorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      options.onEvent({ type: "error", error: "浏览器无法录制课堂音频片段。" });
    };
    recorder.onstop = () => {
      if (cycleTimer) window.clearTimeout(cycleTimer);
      cycleTimer = null;
      activeRecorder = null;
      const audio = new Blob(chunks, { type: mimeType });
      if (audio.size) uploader.enqueue(audio);
      if (!stopped) runCycle();
      else void finishIfStopped();
    };
    recorder.start();
    cycleTimer = window.setTimeout(() => recorder.stop(), chunkDuration(options.delay));
  };

  runCycle();
  options.onState("connected");

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        stopResolver = resolve;
        if (cycleTimer) window.clearTimeout(cycleTimer);
        cycleTimer = null;
        if (activeRecorder?.state === "recording") activeRecorder.stop();
        else void finishIfStopped();
      }),
  };
}

function createOrderedUploader(options: TranscriptionOptions, sessionId: string) {
  const maxParallelUploads = 2;
  let nextSequence = 0;
  let nextEmission = 0;
  let activeUploads = 0;
  let pendingUploads = 0;
  let emittedContext = "";
  const uploadQueue: Array<{ audio: Blob; sequence: number }> = [];
  const completed = new Map<number, { transcript?: string; error?: unknown }>();
  const idleResolvers = new Set<() => void>();

  const resolveIdle = () => {
    if (pendingUploads > 0) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };

  const flushCompleted = () => {
    while (completed.has(nextEmission)) {
      const result = completed.get(nextEmission)!;
      completed.delete(nextEmission);
      if (result.error) {
        options.onEvent({
          type: "error",
          item_id: `${sessionId}-chunk-${nextEmission}`,
          error: result.error,
        });
      } else if (result.transcript) {
        const transcript = removeTranscriptOverlap(emittedContext, result.transcript);
        options.onEvent({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: `${sessionId}-chunk-${nextEmission}`,
          transcript,
        });
        if (transcript) {
          emittedContext = `${emittedContext} ${transcript}`.trim().slice(-800);
        }
      }
      nextEmission += 1;
    }
  };

  const pump = () => {
    while (activeUploads < maxParallelUploads && uploadQueue.length) {
      const task = uploadQueue.shift()!;
      activeUploads += 1;
      void transcribeAudioChunk(task.audio, options)
        .then((transcript) => completed.set(task.sequence, { transcript }))
        .catch((error) => completed.set(task.sequence, { error }))
        .finally(() => {
          activeUploads -= 1;
          pendingUploads -= 1;
          flushCompleted();
          pump();
          resolveIdle();
        });
    }
  };

  return {
    enqueue(audio: Blob) {
      options.onEvent({
        type: "lecture.audio_chunk.queued",
        item_id: `${sessionId}-chunk-${nextSequence}`,
      });
      uploadQueue.push({ audio, sequence: nextSequence });
      nextSequence += 1;
      pendingUploads += 1;
      pump();
    },
    waitForIdle(): Promise<void> {
      if (pendingUploads === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.add(resolve));
    },
  };
}

async function transcribeAudioChunk(audio: Blob, options: TranscriptionOptions): Promise<string> {
  const context = [options.prompt, options.keywords.join(", ")].filter(Boolean).join(". ");
  const response = await fetch("/api/audio/transcriptions", {
    method: "POST",
    headers: {
      "Content-Type": audio.type || "application/octet-stream",
      "X-Lecture-Prompt": encodeURIComponent(context.slice(0, 800)),
    },
    body: audio,
  });
  const payload = (await response.json()) as { transcript?: string; error?: unknown };
  if (!response.ok || !payload.transcript) {
    throw new Error(errorMessage(payload.error, `音频片段转写失败（HTTP ${response.status}）。`));
  }
  return payload.transcript;
}

function supportedRecordingType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  throw new Error("当前浏览器不支持 MediaRecorder 音频录制，请改用最新版 Chrome。" );
}

function chunkDuration(delay: DelayLevel): number {
  if (delay === "minimal") return 3_200;
  if (delay === "low") return 3_400;
  if (delay === "medium") return 4_500;
  return 6_000;
}

function vadProfile(delay: DelayLevel) {
  const common = {
    minSpeechMs: 140,
    preRollMs: 240,
    overlapMs: 240,
  };
  if (delay === "minimal") return { ...common, minChunkMs: 3_000, maxChunkMs: 3_200, silenceMs: 260 };
  if (delay === "low") return { ...common, minChunkMs: 3_000, maxChunkMs: 3_400, silenceMs: 320 };
  if (delay === "medium") return { ...common, minChunkMs: 3_200, maxChunkMs: 4_500, silenceMs: 420 };
  return { ...common, minChunkMs: 3_400, maxChunkMs: 6_000, silenceMs: 560 };
}

function pcmRms(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) {
    const normalized = sample / 0x8000;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function frameDurationMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1_000;
}

function joinFrames(frames: Int16Array[]): Int16Array {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const joined = new Int16Array(length);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}

export function wavBlob(samples: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.byteLength, true);
  new Int16Array(buffer, 44).set(samples);
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function removeTranscriptOverlap(previous: string, current: string): string {
  const previousTokens = tokenize(previous);
  const currentTokens = tokenize(current);
  const maxOverlap = Math.min(10, previousTokens.length, currentTokens.length);
  for (let size = maxOverlap; size >= 1; size -= 1) {
    const previousSlice = previousTokens.slice(-size).map((token) => token.normalized);
    const currentSlice = currentTokens.slice(0, size).map((token) => token.normalized);
    if (!previousSlice.every((token, index) => token && token === currentSlice[index])) continue;
    if (size === 1 && currentSlice[0].length < 5) continue;
    const next = currentTokens[size];
    return next ? current.slice(next.index).trim() : "";
  }
  return current.trim();
}

function tokenize(text: string): Array<{ normalized: string; index: number }> {
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    normalized: match[0].toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, ""),
    index: match.index ?? 0,
  }));
}

function deliverEvent(raw: unknown, callback: (event: RealtimeEvent) => void): void {
  try {
    const event = JSON.parse(String(raw)) as RealtimeEvent;
    callback(event);
  } catch {
    callback({ type: "client.parse_error", error: { message: "收到无法解析的实时事件。" } });
  }
}
