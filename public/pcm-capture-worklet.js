class LecturePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.targetSampleRate = config.targetSampleRate || 16000;
    this.frameSize = config.frameSize || 320;
    this.phase = 0;
    this.sum = 0;
    this.sampleCount = 0;
    this.frame = new Int16Array(this.frameSize);
    this.frameOffset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0].length;

    for (let index = 0; index < length; index += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] || 0;
      mono /= channels.length;

      this.sum += mono;
      this.sampleCount += 1;
      this.phase += this.targetSampleRate;

      if (this.phase >= sampleRate) {
        const averaged = Math.max(-1, Math.min(1, this.sum / this.sampleCount));
        this.frame[this.frameOffset] = averaged < 0 ? averaged * 0x8000 : averaged * 0x7fff;
        this.frameOffset += 1;
        this.phase -= sampleRate;
        this.sum = 0;
        this.sampleCount = 0;

        if (this.frameOffset === this.frameSize) {
          const completed = this.frame;
          this.port.postMessage(completed.buffer, [completed.buffer]);
          this.frame = new Int16Array(this.frameSize);
          this.frameOffset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("lecture-pcm-capture", LecturePcmCaptureProcessor);
