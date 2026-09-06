import type { AudioSource } from "../types";

export async function acquireAudio(source: AudioSource): Promise<MediaStream> {
  let stream: MediaStream;
  if (source === "tab") {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: 48_000 },
      },
    });
  }

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      source === "tab"
        ? "没有捕获到音频。请选择正在播放课程的浏览器标签页，并勾选“共享标签页音频”。"
        : "没有找到可用的麦克风音轨。",
    );
  }
  return stream;
}

export function attachLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4.5));
    frame = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    analyser.disconnect();
    void context.close();
    onLevel(0);
  };
}
