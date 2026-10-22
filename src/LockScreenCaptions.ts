import { PlaybackNotificationManager } from 'react-native-audio-api';
import type { InterpAiCaption } from './types';

export type LockScreenAction = 'play' | 'pause';

const CONTROLS = [
  'play',
  'pause',
  'stop',
  'nextTrack',
  'previousTrack',
  'skipForward',
  'skipBackward',
  'seekTo',
] as const;

/**
 * Publishes live captions through iOS Now Playing and Android's media notification, and
 * optionally play/pause there. Every other control stays off: seeking and skipping mean
 * nothing on a live stream.
 */
export class LockScreenCaptions {
  private playInBackground: boolean;
  private showCaptions: boolean;
  private controls: boolean;
  private paused = false;
  private listening = false;
  private meetingName = '';
  private languageName = '';
  private latestCaption = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private controlsConfigured = false;
  private generation = 0;

  constructor(
    playInBackground: boolean,
    showCaptions: boolean,
    private readonly activateAudio: () => Promise<void>,
    controls = false,
    private readonly onAction: (action: LockScreenAction) => void = () => undefined,
  ) {
    this.playInBackground = playInBackground;
    this.showCaptions = showCaptions;
    this.controls = controls;
  }

  setControls(enabled: boolean): void {
    if (enabled === this.controls) return;
    this.controls = enabled;
    this.controlsConfigured = false;
    this.applySettings();
  }

  /** Reflects the listener's pause in the play/pause control and the playback state. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (this.shouldRun() && this.meetingName) this.publish(this.displayTitle());
  }

  setPlayInBackground(enabled: boolean): void {
    if (enabled === this.playInBackground) return;
    this.playInBackground = enabled;
    this.applySettings();
  }

  setShowCaptions(enabled: boolean): void {
    if (enabled === this.showCaptions) return;
    this.showCaptions = enabled;
    if (!enabled) this.latestCaption = '';
    this.applySettings();
  }

  private applySettings(): void {
    if (!this.shouldRun()) {
      void this.conceal();
      return;
    }
    if (this.meetingName) this.publish(this.displayTitle());
  }

  start(meetingName: string, languageName: string): void {
    this.meetingName = meetingName.trim() || 'Intravo Interpretation';
    this.languageName = languageName.trim();
    this.latestCaption = '';
    this.paused = false;
    ++this.generation;
    if (this.shouldRun()) this.publish(this.displayTitle());
  }

  update(caption: InterpAiCaption): void {
    if (!this.showCaptions) return;
    const text = clamp(caption.text.trim(), 240);
    if (!text) return;
    this.latestCaption = text;
    if (!caption.partial) {
      this.clearTimer();
      this.publish(text);
      return;
    }
    if (this.timer) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (generation === this.generation && this.showCaptions && this.latestCaption) {
        this.publish(this.latestCaption);
      }
    }, 350);
  }

  async hide(): Promise<void> {
    await this.conceal();
    this.meetingName = '';
    this.languageName = '';
    this.latestCaption = '';
  }

  private async conceal(): Promise<void> {
    ++this.generation;
    this.clearTimer();
    this.chain = this.chain.then(() => PlaybackNotificationManager.hide()).catch(() => undefined);
    await this.chain;
  }

  private publish(title: string): void {
    if (!this.shouldRun() || !this.meetingName) return;
    const generation = this.generation;
    const artist = this.meetingName;
    const album = this.languageName ? `${this.languageName} captions` : 'Live captions';
    this.chain = this.chain.then(async () => {
      if (!this.shouldRun() || generation !== this.generation) return;
      // iOS exposes Now Playing metadata only while an AudioContext is active. Android uses the
      // same call to own its media-session notification and foreground playback service.
      await this.activateAudio();
      if (!this.controlsConfigured) {
        const enabled = this.controls;
        await Promise.all(CONTROLS.map(control => PlaybackNotificationManager.enableControl(
          control,
          enabled && (control === 'play' || control === 'pause'),
        )));
        if (enabled) this.listen();
        this.controlsConfigured = true;
      }
      if (!this.shouldRun() || generation !== this.generation) return;
      await PlaybackNotificationManager.show({
        title,
        artist,
        album,
        state: this.paused ? 'paused' : 'playing',
      });
    }).catch(() => undefined);
  }

  /** Subscribed once for the client's lifetime; actions are ignored while nothing is shown. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const forward = (action: LockScreenAction) => () => {
      if (this.controls && this.meetingName) this.onAction(action);
    };
    PlaybackNotificationManager.addEventListener('playbackNotificationPlay', forward('play'));
    PlaybackNotificationManager.addEventListener('playbackNotificationPause', forward('pause'));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private shouldRun(): boolean {
    // Publishing lock-screen captions necessarily owns a background media session too.
    return this.playInBackground || this.showCaptions;
  }

  private displayTitle(): string {
    if (this.showCaptions) return this.latestCaption || 'Live captions';
    return 'Live interpretation';
  }
}

function clamp(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join('')}…`;
}
