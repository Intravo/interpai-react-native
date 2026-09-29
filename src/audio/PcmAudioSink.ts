import {
  AudioBufferQueueSourceNode,
  AudioContext,
  decodeAudioData,
  GainNode,
} from 'react-native-audio-api';
import { buildOpusOggSegment } from './OpusOgg';

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

  async enqueueOpus(
    packets: readonly Uint8Array[],
    primer: readonly Uint8Array[],
  ): Promise<void> {
    const segment = buildOpusOggSegment(packets, primer);
    const input = segment.bytes.buffer.slice(
      segment.bytes.byteOffset,
      segment.bytes.byteOffset + segment.bytes.byteLength,
    ) as ArrayBuffer;
    const decoded = await decodeAudioData(input, 48_000);
    if (decoded.numberOfChannels < 1 || decoded.length < segment.currentSamples) {
      throw new Error('Native Opus decoder returned an incomplete segment.');
    }
    // Any decoder pre-skip and all primer output are at the head. The current segment is the tail.
    const channel = decoded.getChannelData(0);
    await this.enqueueFloat32(channel.subarray(channel.length - segment.currentSamples), 48_000);
  }

  private async enqueueFloat32(samples: Float32Array, sampleRate: number): Promise<void> {
    if (!samples.length || samples.length > sampleRate * 5) return;
    await this.ensureStarted();
    if (!this.context || !this.source) return;
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
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
