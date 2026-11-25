// AudioWorklet: downsample mic audio to 16 kHz mono Int16 PCM and post ~100 ms chunks.
class PcmEncoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.chunk = new Int16Array(1600); // 100 ms @ 16 kHz
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let level = 0;
    // Simple decimation with averaging over each source window.
    while (this.pos < ch.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(ch.length, Math.floor(this.pos + this.ratio));
      let sum = 0, n = 0;
      for (let i = start; i < Math.max(end, start + 1); i++) { sum += ch[i]; n++; }
      const s = Math.max(-1, Math.min(1, sum / n));
      level = Math.max(level, Math.abs(s));
      this.chunk[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.len === this.chunk.length) {
        this.port.postMessage({ pcm: this.chunk.buffer }, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.len = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.port.postMessage({ level });
    return true;
  }
}
registerProcessor('pcm-encoder', PcmEncoder);
