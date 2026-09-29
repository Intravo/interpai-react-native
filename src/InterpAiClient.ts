import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { PcmAudioSink } from './audio/PcmAudioSink';
import { LockScreenCaptions } from './LockScreenCaptions';
import { AudioHeader, EventLadder, EventTransport, WireEvent } from './transport/EventLadder';
import type {
  InterpAiCaption,
  InterpAiCaptionTransport,
  InterpAiClientOptions,
  InterpAiConnectOptions,
  InterpAiLanguage,
  InterpAiMeeting,
  InterpAiState,
  InterpAiTransportState,
} from './types';

type Envelope<T> = { success: true; data: T } | { success: false; error?: { code?: string; message?: string } };
type IceServer = { urls: string | string[]; username?: string; credential?: string };
type Sdp = { type: 'offer' | 'answer'; sdp: string };
type Subscribe = { available: boolean; reason?: string; detail?: string; session_id?: string; answer?: Sdp };
type Pull = { available: boolean; reason?: string; detail?: string; offer?: Sdp; requires_renegotiation?: boolean };

export class InterpAiApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'InterpAiApiError';
  }
}

/**
 * One client for the complete public listener contract.
 *
 * Audio: WebRTC (including TURN/TCP/TLS from the server ICE response) -> socket PCM when present ->
 * HTTPS PCM segments. Captions: WebSocket -> SSE -> durable HTTPS poll.
 */
export class InterpAiClient {
  private readonly apiBaseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly callbacks: InterpAiClientOptions;
  private readonly pcm = new PcmAudioSink();
  private readonly lockScreen: LockScreenCaptions;
  private showCaptions: boolean;
  private state: InterpAiState = 'closed';
  private transport: InterpAiTransportState = { audio: 'none', captions: 'off' };
  private peer: RTCPeerConnection | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private audioEvents: EventLadder | null = null;
  private captionEvents: EventLadder | null = null;
  private accessCode: string | null = null;
  private language: string | null = null;
  private captionLanguage: string | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private volume = 1;
  private muted = false;
  private webrtcHealthy = false;
  private seenCaptions = new Set<string>();
  private seenCaptionOrder: string[] = [];
  private seenAudio = new Set<number>();
  private seenAudioOrder: number[] = [];
  private pendingAudioMeta = new Map<number, WireEvent>();
  private pendingOpus = new Set<number>();
  private opusPrimer: Uint8Array[] = [];
  private opusFailures = 0;
  private opusDisabled = false;
  private pcmChain: Promise<void> = Promise.resolve();

  constructor(options: InterpAiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.showCaptions = options.showCaptions ?? true;
    this.callbacks = options;
    this.lockScreen = new LockScreenCaptions(
      options.playInBackground ?? false,
      options.showCaptionsOnLockScreen ?? false,
      () => this.pcm.activate(),
    );
  }

  async getMeeting(rawAccessCode: string): Promise<InterpAiMeeting> {
    const accessCode = this.requireAccessCode(rawAccessCode);
    const meeting = await this.post<InterpAiMeeting>('/api/public/listen/validate-code', {
      access_code: accessCode,
    });
    this.callbacks.onMeeting?.(meeting);
    return meeting;
  }

  /** Return only the language routes currently configured for this meeting. */
  async getAvailableLanguages(rawAccessCode: string): Promise<InterpAiLanguage[]> {
    return (await this.getMeeting(rawAccessCode)).languages;
  }

  async connect(options: InterpAiConnectOptions): Promise<InterpAiMeeting> {
    const accessCode = this.requireAccessCode(options.accessCode);
    await this.disconnect();
    const generation = ++this.generation;
    this.emitState('connecting');

    const meeting = await this.getMeeting(accessCode);
    const language = this.requireReturnedLanguage(meeting, options.language);
    const captionLanguage = this.requireReturnedLanguage(
      meeting,
      options.captionLanguage ?? language,
    );
    if (generation !== this.generation) return meeting;

    this.accessCode = accessCode;
    this.language = language;
    this.captionLanguage = captionLanguage;
    const captionLanguageName = meeting.languages.find(item => item.code === captionLanguage)?.name
      ?? captionLanguage;
    this.lockScreen.start(meeting.meeting_name, captionLanguageName);
    this.startEventLadders(accessCode, language, captionLanguage);

    try {
      await this.connectWebRtc(generation);
    } catch {
      if (generation === this.generation) {
        this.webrtcHealthy = false;
        this.emitTransport({ audio: 'https-pcm' });
        this.emitState('fallback');
        this.scheduleWebRtcRetry(generation);
      }
    }
    return meeting;
  }

  setShowCaptions(show: boolean): void {
    this.showCaptions = show;
  }

  setShowCaptionsOnLockScreen(show: boolean): void {
    this.lockScreen.setShowCaptions(show);
  }

  setPlayInBackground(play: boolean): void {
    this.lockScreen.setPlayInBackground(play);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.pcm.setMuted(muted);
    this.applyRemoteVolume();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.pcm.setVolume(this.volume);
    this.applyRemoteVolume();
  }

  /** Reconnect immediately after the operating system reports network recovery. */
  wake(): void {
    this.audioEvents?.wake();
    this.captionEvents?.wake();
    if (!this.webrtcHealthy && this.accessCode && this.language) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      void this.connectWebRtc(this.generation).catch(() => this.scheduleWebRtcRetry(this.generation));
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.audioEvents?.stop();
    this.captionEvents?.stop();
    this.audioEvents = null;
    this.captionEvents = null;
    await this.closePeer();
    await this.lockScreen.hide();
    this.pcm.clear();
    await this.pcm.close();
    this.accessCode = null;
    this.language = null;
    this.captionLanguage = null;
    this.seenCaptions.clear();
    this.seenCaptionOrder = [];
    this.seenAudio.clear();
    this.seenAudioOrder = [];
    this.pendingAudioMeta.clear();
    this.pendingOpus.clear();
    this.opusPrimer = [];
    this.opusFailures = 0;
    this.opusDisabled = false;
    this.webrtcHealthy = false;
    this.retryAttempt = 0;
    this.emitTransport({ audio: 'none', captions: 'off' });
    this.emitState('closed');
  }

  private startEventLadders(accessCode: string, language: string, captionLanguage: string): void {
    const audioLadder = new EventLadder({
      apiBaseUrl: this.apiBaseUrl,
      accessCode,
      language,
      acceptAudio: true,
      onEvents: (events, transport) => this.applyEvents(events, transport, true),
      onPcm: (header, pcm, transport) => this.applySocketPcm(header, pcm, transport),
      onOpus: (header, packets, transport) => this.applySocketOpus(header, packets, transport),
      onTransport: transport => {
        if (captionLanguage === language) this.emitTransport({ captions: transport });
      },
    });
    this.audioEvents = audioLadder;
    audioLadder.start();

    if (captionLanguage !== language) {
      const captions = new EventLadder({
        apiBaseUrl: this.apiBaseUrl,
        accessCode,
        language: captionLanguage,
        acceptAudio: false,
        onEvents: (events, transport) => this.applyEvents(events, transport, false),
        onPcm: () => undefined,
        onOpus: () => undefined,
        onTransport: transport => this.emitTransport({ captions: transport }),
      });
      this.captionEvents = captions;
      captions.start();
    }
  }

  private applyEvents(events: WireEvent[], transport: EventTransport, carriesAudio: boolean): void {
    const carriesSelectedCaptions = !carriesAudio || this.captionLanguage === this.language;
    if (carriesSelectedCaptions && this.transport.captions !== transport) {
      this.emitTransport({ captions: transport as InterpAiCaptionTransport });
    }
    for (const event of events) {
      const payload = event.payload ?? {};
      const language = String(event.language ?? payload.language ?? '');
      if (event.kind === 'transcript' && language === this.captionLanguage) this.applyCaption(event);
      if (carriesAudio && event.kind === 'audio_meta' && language === this.language) {
        void this.fetchPcmFallback(event);
      }
    }
  }

  private applyCaption(event: WireEvent): void {
    const payload = event.payload ?? {};
    const partial = payload.partial === true;
    const sequence = Number(event.sequence ?? payload.sequence ?? 0);
    const language = String(event.language ?? payload.language ?? '');
    const text = String(payload.translation ?? payload.text ?? payload.source ?? '').trim();
    if (!text) return;
    if (!partial && sequence > 0) {
      const key = `${language}:${sequence}`;
      if (this.seenCaptions.has(key)) return;
      this.seenCaptions.add(key);
      this.seenCaptionOrder.push(key);
      if (this.seenCaptionOrder.length > 400) this.seenCaptions.delete(this.seenCaptionOrder.shift()!);
    }
    const caption: InterpAiCaption = {
      text,
      sourceText: typeof payload.source === 'string' ? payload.source : undefined,
      language,
      sequence,
      partial,
    };
    this.lockScreen.update(caption);
    if (this.showCaptions) this.callbacks.onCaption?.(caption);
  }

  private applySocketPcm(
    header: AudioHeader,
    pcm: Uint8Array,
    transport: 'websocket-pcm' | 'sse-pcm',
  ): void {
    if (this.webrtcHealthy || this.muted || !this.claimAudio(header.sequence)) return;
    this.emitTransport({ audio: transport });
    this.emitState('fallback');
    this.pcmChain = this.pcmChain.then(() => this.pcm.enqueue(pcm, header.sample_rate)).catch(() => undefined);
  }

  private applySocketOpus(
    header: AudioHeader,
    packets: Uint8Array[],
    transport: 'websocket-opus' | 'sse-opus',
  ): void {
    if (this.opusDisabled || this.webrtcHealthy || this.muted || !this.claimAudio(header.sequence)) return;
    const primer = this.opusPrimer;
    this.opusPrimer = packets.slice(-2);
    if (header.sequence > 0) this.pendingOpus.add(header.sequence);
    this.emitTransport({ audio: transport });
    this.emitState('fallback');
    this.pcmChain = this.pcmChain.then(async () => {
      await this.pcm.enqueueOpus(packets, primer);
      this.opusFailures = 0;
      this.pendingOpus.delete(header.sequence);
      this.pendingAudioMeta.delete(header.sequence);
    }).catch(() => {
      this.pendingOpus.delete(header.sequence);
      this.releaseAudio(header.sequence);
      if (++this.opusFailures >= 3) this.opusDisabled = true;
      const fallback = this.pendingAudioMeta.get(header.sequence);
      this.pendingAudioMeta.delete(header.sequence);
      if (fallback) void this.fetchPcmFallback(fallback);
    });
  }

  private async fetchPcmFallback(event: WireEvent): Promise<void> {
    if (this.webrtcHealthy || this.muted) return;
    const payload = event.payload ?? {};
    const meta = (payload.audio_meta ?? payload) as Record<string, unknown>;
    const sequence = Number(event.sequence ?? payload.sequence ?? meta.sequence ?? 0);
    const path = String(meta.url ?? '');
    if (!this.safeAudioPath(path)) return;
    if (sequence > 0 && this.seenAudio.has(sequence)) {
      if (this.pendingOpus.has(sequence)) this.pendingAudioMeta.set(sequence, event);
      return;
    }
    if (!this.claimAudio(sequence)) return;
    const generation = this.generation;
    const fetching = fetch(`${this.apiBaseUrl}${path}`, { headers: { Accept: 'application/octet-stream' } })
      .then(response => {
        if (!response.ok) throw new Error(`audio HTTP ${response.status}`);
        return response.arrayBuffer();
      });
    fetching.catch(() => undefined);
    this.pcmChain = this.pcmChain.then(async () => {
      const bytes = await fetching;
      if (generation !== this.generation || this.webrtcHealthy || this.muted) return;
      this.emitTransport({ audio: 'https-pcm' });
      this.emitState('fallback');
      await this.pcm.enqueue(bytes, Number(meta.sample_rate ?? 24_000));
    }).catch(() => this.releaseAudio(sequence));
  }

  private async connectWebRtc(generation: number): Promise<void> {
    if (!this.accessCode || !this.language || generation !== this.generation) return;
    await this.closePeer();
    const accessCode = this.accessCode;
    const language = this.language;
    let iceServers: IceServer[] = [];
    try {
      const ice = await this.get<{ iceServers?: IceServer[] }>(
        `/api/public/webrtc/ice?access_code=${encodeURIComponent(accessCode)}`,
      );
      iceServers = Array.isArray(ice.iceServers) ? ice.iceServers : [];
    } catch { /* direct candidates may still work; fallback ladder is already live */ }
    if (generation !== this.generation) return;

    const peer = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.peer = peer;
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = (event: unknown) => {
      const track = (event as { track?: MediaStreamTrack | null }).track;
      if (!track || track.kind !== 'audio' || generation !== this.generation) return;
      this.remoteTrack = track;
      this.applyRemoteVolume();
      this.callbacks.onRemoteTrack?.(track);
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const localOffer = peer.localDescription ?? offer;
    const subscribed = await this.post<Subscribe>('/api/public/webrtc/subscribe', {
      access_code: accessCode,
      language,
      sdp: { type: 'offer', sdp: localOffer.sdp },
    });
    if (!subscribed.available || !subscribed.session_id || !subscribed.answer) {
      throw new Error(subscribed.reason ?? 'SFU_UNAVAILABLE');
    }
    this.sessionId = subscribed.session_id;
    await peer.setRemoteDescription(new RTCSessionDescription(subscribed.answer));
    await this.waitForConnected(peer, generation);
    const pulled = await this.post<Pull>('/api/public/webrtc/pull', {
      access_code: accessCode,
      session_id: subscribed.session_id,
    });
    if (!pulled.available) throw new Error(pulled.reason ?? 'SFU_UNAVAILABLE');
    if (pulled.offer) {
      await peer.setRemoteDescription(new RTCSessionDescription(pulled.offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (pulled.requires_renegotiation) {
        await this.post<{ ok: boolean }>('/api/public/webrtc/renegotiate', {
          access_code: accessCode,
          session_id: subscribed.session_id,
          sdp: { type: 'answer', sdp: (peer.localDescription ?? answer).sdp },
        });
      }
    }
    if (generation !== this.generation) return;
    this.webrtcHealthy = true;
    this.retryAttempt = 0;
    this.pcm.clear();
    this.emitTransport({ audio: 'webrtc' });
    this.emitState('live');
    this.installWebRtcSupervisor(peer, generation);
  }

  private installWebRtcSupervisor(peer: RTCPeerConnection, generation: number): void {
    const changed = () => {
      if (generation !== this.generation || peer !== this.peer) return;
      const failed = peer.connectionState === 'failed' || peer.connectionState === 'closed'
        || peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'closed';
      if (!failed) return;
      this.webrtcHealthy = false;
      this.emitTransport({ audio: 'https-pcm' });
      this.emitState('fallback');
      this.scheduleWebRtcRetry(generation);
    };
    peer.onconnectionstatechange = changed;
    peer.oniceconnectionstatechange = changed;
  }

  private scheduleWebRtcRetry(generation: number): void {
    if (generation !== this.generation || !this.accessCode) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delays = [3_000, 5_000, 10_000, 15_000];
    const delay = delays[Math.min(this.retryAttempt++, delays.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      void this.connectWebRtc(generation).catch(() => this.scheduleWebRtcRetry(generation));
    }, delay);
  }

  private waitForConnected(peer: RTCPeerConnection, generation: number): Promise<void> {
    const ready = () => peer.connectionState === 'connected'
      || peer.iceConnectionState === 'connected'
      || peer.iceConnectionState === 'completed';
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (peer.onconnectionstatechange === changed) peer.onconnectionstatechange = null;
        if (peer.oniceconnectionstatechange === changed) peer.oniceconnectionstatechange = null;
        error ? reject(error) : resolve();
      };
      const changed = () => {
        if (generation !== this.generation) return finish(new Error('Connection replaced'));
        if (ready()) return finish();
        if (peer.connectionState === 'failed' || peer.iceConnectionState === 'failed') {
          finish(new Error('WebRTC connection failed'));
        }
      };
      const timer = setTimeout(() => finish(new Error('WebRTC connection timed out')), this.connectTimeoutMs);
      peer.onconnectionstatechange = changed;
      peer.oniceconnectionstatechange = changed;
    });
  }

  private async closePeer(): Promise<void> {
    const peer = this.peer;
    const accessCode = this.accessCode;
    const sessionId = this.sessionId;
    this.peer = null;
    this.remoteTrack = null;
    this.sessionId = null;
    peer?.close();
    if (accessCode && sessionId) {
      try {
        await this.post<{ ok: boolean }>('/api/public/webrtc/leave', {
          access_code: accessCode,
          session_id: sessionId,
        });
      } catch { /* meeting-stop cleanup remains durable */ }
    }
  }

  private applyRemoteVolume(): void {
    const track = this.remoteTrack as (MediaStreamTrack & { _setVolume?: (value: number) => void }) | null;
    if (!track) return;
    if (typeof track._setVolume === 'function') track._setVolume(this.muted ? 0 : this.volume);
    else track.enabled = !this.muted && this.volume > 0;
  }

  private claimAudio(sequence: number): boolean {
    if (!Number.isFinite(sequence) || sequence <= 0) return true;
    if (this.seenAudio.has(sequence)) return false;
    this.seenAudio.add(sequence);
    this.seenAudioOrder.push(sequence);
    if (this.seenAudioOrder.length > 128) this.seenAudio.delete(this.seenAudioOrder.shift()!);
    return true;
  }

  private releaseAudio(sequence: number): void {
    if (sequence <= 0) return;
    this.seenAudio.delete(sequence);
    const index = this.seenAudioOrder.indexOf(sequence);
    if (index >= 0) this.seenAudioOrder.splice(index, 1);
  }

  private safeAudioPath(path: string): boolean {
    return /^\/api\/public\/meetings\/[A-Za-z0-9-]{5,16}\/audio\/[a-fA-F0-9]{32}$/.test(path);
  }

  private requireAccessCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!/^[A-Z0-9-]{5,16}$/.test(code)) {
      throw new InterpAiApiError('MALFORMED_ACCESS_CODE', 'Enter a valid meeting access code.', 0);
    }
    return code;
  }

  private requireReturnedLanguage(meeting: InterpAiMeeting, requested: string): string {
    const found = meeting.languages.find(item => item.code.toLowerCase() === requested.toLowerCase());
    if (!found) throw new InterpAiApiError('VALIDATION_ERROR', 'Choose a returned meeting language.', 0);
    return found.code;
  }

  private emitState(state: InterpAiState): void {
    if (state === this.state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private emitTransport(change: Partial<InterpAiTransportState>): void {
    const next = { ...this.transport, ...change };
    if (next.audio === this.transport.audio && next.captions === this.transport.captions) return;
    this.transport = next;
    this.callbacks.onTransportChange?.(next);
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
    const body = await response.json() as Envelope<T>;
    if (!response.ok || !body.success) {
      const error = body.success ? undefined : body.error;
      throw new InterpAiApiError(
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? 'Intravo API request failed.',
        response.status,
      );
    }
    return body.data;
  }
}
