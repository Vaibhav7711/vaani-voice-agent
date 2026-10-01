export type VadTransition = "speech_started" | "speech_stopped" | null;

export class PcmVoiceActivityDetector {
  private speaking = false;
  private speechFrames = 0;
  private silenceFrames = 0;

  constructor(
    private readonly threshold = 0.018,
    private readonly startFrames = 3,
    private readonly stopFrames = 22,
  ) {}

  push(frame: Buffer): VadTransition {
    if (frame.byteLength < 2) return null;
    let squared = 0;
    const samples = Math.floor(frame.byteLength / 2);
    for (let offset = 0; offset + 1 < frame.byteLength; offset += 2) {
      const value = frame.readInt16LE(offset) / 32768;
      squared += value * value;
    }
    const rms = Math.sqrt(squared / samples);

    if (rms >= this.threshold) {
      this.speechFrames += 1;
      this.silenceFrames = 0;
      if (!this.speaking && this.speechFrames >= this.startFrames) {
        this.speaking = true;
        return "speech_started";
      }
      return null;
    }

    this.speechFrames = 0;
    if (!this.speaking) return null;
    this.silenceFrames += 1;
    if (this.silenceFrames >= this.stopFrames) {
      this.speaking = false;
      this.silenceFrames = 0;
      return "speech_stopped";
    }
    return null;
  }

  get isSpeaking() {
    return this.speaking;
  }
}
