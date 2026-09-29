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
  connectTimeoutMs?: number;
  onStateChange?: (state: InterpAiState) => void;
  onTransportChange?: (transport: InterpAiTransportState) => void;
  onCaption?: (caption: InterpAiCaption) => void;
  onMeeting?: (meeting: InterpAiMeeting) => void;
  onRemoteTrack?: (track: MediaStreamTrack) => void;
};

export type InterpAiConnectOptions = {
  accessCode: string;
  language: string;
  /** Defaults to the audio language. A second resilient caption stream is opened when different. */
  captionLanguage?: string;
};
