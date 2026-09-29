import { toByteArray } from 'base64-js';
import { ungzip } from 'pako';
import EventSource, { EventSourceEvent } from 'react-native-sse';

export type WireEvent = {
  id?: number;
  oid?: number;
  kind?: string;
  language?: string;
  sequence?: number;
  payload?: Record<string, unknown>;
};

export type AudioHeader = {
  t: 'audio';
  language: string;
  sequence: number;
  format: 'pcm_s16le' | 'opus';
  encoding: 'gzip' | 'none';
  sample_rate: number;
  channels: number;
  duration_ms: number;
  data?: string;
};

export type EventTransport = 'websocket' | 'sse' | 'poll';
type SseKind = 'welcome' | 'meeting' | 'caption' | 'audio' | 'cursor';
type Envelope<T> = { success: true; data: T } | { success: false; error?: { code?: string; message?: string } };
type Join = { transport_url: string; token: string; expires_in: number };

type Options = {
  apiBaseUrl: string;
  accessCode: string;
  language: string;
  acceptAudio: boolean;
  onEvents: (events: WireEvent[], transport: EventTransport) => void;
  onPcm: (header: AudioHeader, pcm: Uint8Array, transport: 'websocket-pcm' | 'sse-pcm') => void;
  onTransport: (transport: EventTransport) => void;
};

const RETRIES = [1_000, 2_000, 5_000, 10_000];

/** Caption and backup-audio discovery ladder: WebSocket -> SSE -> durable HTTPS poll. */
export class EventLadder {
  private readonly apiBaseUrl: string;
  private readonly accessCode: string;
  private language: string;
  private readonly acceptAudio: boolean;
  private readonly onEvents: Options['onEvents'];
  private readonly onPcm: Options['onPcm'];
  private readonly onTransport: Options['onTransport'];
  private stopped = true;
  private generation = 0;
  private rung = 0;
  private attempts = 0;
  private pushSince = 0;
  private pollSince = 0;
  private live = false;
  private ws: WebSocket | null = null;
  private sse: EventSource<SseKind> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Options) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.accessCode = options.accessCode;
    this.language = options.language;
    this.acceptAudio = options.acceptAudio;
    this.onEvents = options.onEvents;
    this.onPcm = options.onPcm;
    this.onTransport = options.onTransport;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.rung = 0;
    this.attempts = 0;
    void this.connect(++this.generation);
  }

  stop(): void {
    this.stopped = true;
    ++this.generation;
    this.teardown();
  }

  setLanguage(language: string): void {
    if (language === this.language) return;
    this.language = language;
    this.pushSince = 0;
    this.pollSince = 0;
    this.rung = 0;
    this.attempts = 0;
    if (!this.stopped) {
      this.teardown();
      void this.connect(++this.generation);
    }
  }

  wake(): void {
    if (this.stopped) return;
    this.teardown();
    void this.connect(++this.generation);
  }

  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    if (this.rung === 0) return this.connectWebSocket(generation);
    if (this.rung === 1) return this.connectSse(generation);
    this.onTransport('poll');
    this.schedulePoll(0, generation);
  }

  private async join(): Promise<Join | null> {
    const url = `${this.apiBaseUrl}/api/public/meetings/${encodeURIComponent(this.accessCode)}`
      + `/captions-join?language=${encodeURIComponent(this.language)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 404 || response.status === 501) return null;
    const body = await response.json() as Envelope<Join>;
    if (!response.ok || !body.success) {
      const code = body.success ? undefined : body.error?.code;
      if (code === 'CAPTIONS_PUSH_DISABLED' || code === 'RELAY_DISABLED') return null;
      throw new Error(body.success ? `HTTP ${response.status}` : body.error?.message);
    }
    return body.data;
  }

  private async connectWebSocket(generation: number): Promise<void> {
    this.onTransport('websocket');
    let join: Join | null;
    try { join = await this.join(); } catch { return this.retryOrDemote(generation, false); }
    if (!join || this.stopped || generation !== this.generation) {
      if (!join) this.demote(generation);
      return;
    }
    const url = join.transport_url.replace(/^http/, 'ws')
      + `/subscribe/${encodeURIComponent(this.accessCode)}?since=${this.pushSince}`;
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['intravo.captions.v1', join.token]);
      ws.binaryType = 'arraybuffer';
    } catch { return this.retryOrDemote(generation, false); }
    this.ws = ws;
    ws.onopen = () => {
      if (generation !== this.generation) return ws.close();
      opened = true;
      this.attempts = 0;
    };
    ws.onmessage = event => {
      if (generation !== this.generation) return;
      if (typeof event.data === 'string') {
        try { this.handleFrame(JSON.parse(event.data), 'websocket'); } catch { /* ignore one frame */ }
      } else if (this.acceptAudio) void this.handleBinary(event.data);
    };
    ws.onerror = () => { /* close owns recovery */ };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped && generation === this.generation) this.retryOrDemote(generation, opened);
    };
  }

  private async connectSse(generation: number): Promise<void> {
    this.onTransport('sse');
    let join: Join | null;
    try { join = await this.join(); } catch { return this.retryOrDemote(generation, false); }
    if (!join || this.stopped || generation !== this.generation) {
      if (!join) this.demote(generation);
      return;
    }
    const query = `token=${encodeURIComponent(join.token)}&since=${this.pushSince}`
      + `&lang=${encodeURIComponent(this.language)}`;
    const sse = new EventSource<SseKind>(
      `${join.transport_url}/stream/${encodeURIComponent(this.accessCode)}?${query}`,
      { pollingInterval: 5_000, timeoutBeforeConnection: 0 },
    );
    this.sse = sse;
    let opened = false;
    sse.addEventListener('open', () => {
      if (generation !== this.generation) return sse.close();
      opened = true;
      this.attempts = 0;
    });
    const jsonFrame = (event: EventSourceEvent<SseKind>) => {
      if (generation !== this.generation || !('data' in event) || !event.data) return;
      try { this.handleFrame(JSON.parse(event.data), 'sse'); } catch { /* ignore one frame */ }
    };
    sse.addEventListener('welcome', jsonFrame);
    sse.addEventListener('meeting', jsonFrame);
    sse.addEventListener('caption', event => {
      if (!event.data || generation !== this.generation) return;
      try {
        const row = JSON.parse(event.data) as WireEvent;
        this.handleFrame({ type: 'events', events: [row], cursor: row.id }, 'sse');
      } catch { /* ignore one frame */ }
    });
    sse.addEventListener('audio', event => {
      if (!this.acceptAudio || !event.data || generation !== this.generation) return;
      try { void this.handleSseAudio(JSON.parse(event.data) as AudioHeader); } catch { /* ignore */ }
    });
    sse.addEventListener('cursor', event => {
      if (!event.data) return;
      try {
        const cursor = Number((JSON.parse(event.data) as { cursor?: number }).cursor);
        if (cursor > this.pushSince) this.pushSince = cursor;
      } catch { /* ignore */ }
    });
    sse.addEventListener('error', () => {
      if (this.stopped || generation !== this.generation || opened) return;
      sse.close();
      if (this.sse === sse) this.sse = null;
      this.retryOrDemote(generation, false);
    });
  }

  private handleFrame(frame: Record<string, unknown>, transport: EventTransport): void {
    const type = String(frame.type ?? '');
    if (type === 'welcome' || type === 'meeting') {
      const meeting = frame.meeting as { status?: string } | undefined;
      this.live = meeting?.status === 'active' || meeting?.status === 'live';
      return;
    }
    if (type !== 'events' || !Array.isArray(frame.events)) return;
    const rows = frame.events as WireEvent[];
    for (const row of rows) {
      const id = Number(row.id ?? 0);
      const oid = Number(row.oid ?? 0);
      if (id > this.pushSince) this.pushSince = id;
      if (oid > this.pollSince) this.pollSince = oid;
    }
    if (rows.length) this.onEvents(rows, transport);
    if (frame.has_more && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resume', since: this.pushSince }));
    }
  }

  private async handleBinary(raw: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) {
      const view = raw as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else if (typeof Blob !== 'undefined' && raw instanceof Blob) bytes = new Uint8Array(await raw.arrayBuffer());
    else return;
    if (bytes.byteLength < 4) return;
    const size = bytes[0]! | (bytes[1]! << 8);
    if (size < 2 || size > 2_048 || bytes.byteLength <= 2 + size) return;
    let header: AudioHeader;
    try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(2, 2 + size))); } catch { return; }
    await this.deliverPcm(header, bytes.subarray(2 + size), 'websocket-pcm');
  }

  private async handleSseAudio(header: AudioHeader): Promise<void> {
    if (typeof header.data !== 'string') return;
    let payload: Uint8Array;
    try { payload = toByteArray(header.data); } catch { return; }
    await this.deliverPcm(header, payload, 'sse-pcm');
  }

  private async deliverPcm(
    header: AudioHeader,
    payload: Uint8Array,
    transport: 'websocket-pcm' | 'sse-pcm',
  ): Promise<void> {
    if (header.t !== 'audio' || header.language !== this.language || header.channels !== 1) return;
    // Opus is deliberately left unclaimed: its matching audio_meta event immediately selects the
    // universally decodable HTTPS PCM rung. PCM compatibility frames are played directly.
    if (header.format !== 'pcm_s16le') return;
    if (header.encoding !== 'gzip' && header.encoding !== 'none') return;
    const pcm = header.encoding === 'gzip' ? ungzip(payload) : payload;
    this.onPcm(header, pcm, transport);
  }

  private schedulePoll(delay: number, generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(generation), delay);
  }

  private async poll(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    const url = `${this.apiBaseUrl}/api/public/meetings/${encodeURIComponent(this.accessCode)}`
      + `/events?since=${this.pollSince}&language=${encodeURIComponent(this.language)}`;
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await response.json() as Envelope<{
        meeting?: { status?: string };
        events?: WireEvent[];
        has_more?: boolean;
      }>;
      if (!response.ok || !body.success) throw new Error(`HTTP ${response.status}`);
      this.live = body.data.meeting?.status === 'active' || body.data.meeting?.status === 'live';
      const rows = Array.isArray(body.data.events) ? body.data.events : [];
      for (const row of rows) {
        const id = Number(row.id ?? 0);
        if (id > this.pollSince) this.pollSince = id;
      }
      if (rows.length) this.onEvents(rows, 'poll');
      this.attempts = 0;
      this.schedulePoll(body.data.has_more ? 0 : (this.live ? 500 : 2_500), generation);
    } catch {
      const delay = RETRIES[Math.min(this.attempts++, RETRIES.length - 1)]!;
      this.schedulePoll(delay, generation);
    }
  }

  private retryOrDemote(generation: number, opened: boolean): void {
    if (this.stopped || generation !== this.generation) return;
    if (!opened && ++this.attempts >= 2) return this.demote(generation);
    const delay = RETRIES[Math.min(this.attempts, RETRIES.length - 1)]!;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(generation), delay);
  }

  private demote(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.closeHandles();
    this.rung = Math.min(2, this.rung + 1);
    this.attempts = 0;
    void this.connect(generation);
  }

  private teardown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closeHandles();
  }

  private closeHandles(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
    }
    if (this.sse) {
      this.sse.removeAllEventListeners();
      this.sse.close();
      this.sse = null;
    }
  }
}
