import {
  AudioBufferQueueSourceNode,
  AudioContext,
  GainNode,
} from 'react-native-audio-api';

/** Native, gap-resistant PCM playback for the restricted-network HTTPS fallback. */
export class PcmAudioSink {
  private context: AudioContext | null = null;
  private source: AudioBufferQueueSourceNode | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private muted = false;

  async enqueue(raw: ArrayBuffer | Uint8Array, sampleRate: number): Promise<void> {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength < 2 || (bytes.byteLength & 1) !== 0) return;
    if (![16_000, 24_000, 48_000].includes(sampleRate)) return;

    await this.ensureStarted();
    if (!this.context || !this.source) return;
    const samples = bytes.byteLength / 2;
    const buffer = this.context.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    this.source.enqueueBuffer(buffer);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyGain();
  }

  clear(): void {
    this.source?.clearBuffers();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.source = null;
    this.gain = null;
    if (context) await context.close();
  }

  private async ensureStarted(): Promise<void> {
    if (this.context && this.source && this.gain) {
      if (this.context.state === 'suspended') await this.context.resume();
      return;
    }
    const context = new AudioContext();
    const source = context.createBufferQueueSource({ pitchCorrection: true });
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    this.context = context;
    this.source = source;
    this.gain = gain;
    this.applyGain();
    if (context.state === 'suspended') await context.resume();
  }

  private applyGain(): void {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}
