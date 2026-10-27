import type { MediaStreamTrack } from 'react-native-webrtc';

export type InterpAiLanguage = {
  code: string;
  name: string;
  tier?: 'standard' | 'premium';
  webrtc?: boolean;
};

export type InterpAiMeeting = {
  meeting_name: string;
  status: 'idle' | 'active' | 'ended';
  languages: InterpAiLanguage[];
  registration: boolean;
};

export type InterpAiCaption = {
  text: string;
  sourceText?: string;
  language: string;
  sequence: number;
  partial: boolean;
};

export type InterpAiState = 'closed' | 'connecting' | 'live' | 'fallback' | 'unavailable';

export type InterpAiAudioTransport =
  | 'webrtc'
  | 'websocket-opus'
  | 'sse-opus'
  | 'websocket-pcm'
  | 'sse-pcm'
  | 'https-pcm'
  | 'none';

export type InterpAiCaptionTransport = 'websocket' | 'sse' | 'poll' | 'off';

export type InterpAiTransportState = {
  audio: InterpAiAudioTransport;
  captions: InterpAiCaptionTransport;
};

export type InterpAiClientOptions = {
  apiBaseUrl: string;
  /** Emits caption callbacks and allows the managed component to render them. Default: true. */
  showCaptions?: boolean;
  /** Keeps interpretation audio active while the app is backgrounded or the phone is locked. */
  playInBackground?: boolean;
  /** Publishes captions to iOS Now Playing and Android's media notification. Default: false. */
  showCaptionsOnLockScreen?: boolean;
  /**
   * Shows play/pause on the lock screen and in Android's media notification while the
   * background media session is active. Pausing silences the stream but keeps the connection,
   * so resuming is instant. Default: false.
   */
  lockScreenControls?: boolean;
  connectTimeoutMs?: number;
  onStateChange?: (state: InterpAiState) => void;
  onTransportChange?: (transport: InterpAiTransportState) => void;
  onCaption?: (caption: InterpAiCaption) => void;
  /** The listener paused or resumed: from the lock screen, pause()/resume(), or disconnect(). */
  onPausedChange?: (paused: boolean) => void;
  onMeeting?: (meeting: InterpAiMeeting) => void;
  onRemoteTrack?: (track: MediaStreamTrack) => void;
};

export type InterpAiConnectOptions = {
  accessCode: string;
  language: string;
  /** Defaults to the audio language. A second resilient caption stream is opened when different. */
  captionLanguage?: string;
};
