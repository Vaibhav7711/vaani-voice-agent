class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingLength = 0;
    this.frameSize = 320;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    this.pending.push(new Float32Array(channel));
    this.pendingLength += channel.length;

    while (this.pendingLength >= this.frameSize) {
      const output = new Int16Array(this.frameSize);
      let outputOffset = 0;
      while (outputOffset < this.frameSize && this.pending.length > 0) {
        const first = this.pending[0];
        const take = Math.min(first.length, this.frameSize - outputOffset);
        for (let index = 0; index < take; index += 1) {
          const sample = Math.max(-1, Math.min(1, first[index]));
          output[outputOffset + index] = sample < 0 ? sample * 32768 : sample * 32767;
        }
        outputOffset += take;
        if (take === first.length) this.pending.shift();
        else this.pending[0] = first.slice(take);
        this.pendingLength -= take;
      }
      this.port.postMessage(output.buffer, [output.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
