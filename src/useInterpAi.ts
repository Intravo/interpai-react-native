import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InterpAiClient } from './InterpAiClient';
import type {
  InterpAiCaption,
  InterpAiMeeting,
  InterpAiState,
  InterpAiTransportState,
} from './types';

export type UseInterpAiOptions = {
  apiBaseUrl: string;
  showCaptions?: boolean;
  playInBackground?: boolean;
  showCaptionsOnLockScreen?: boolean;
  maxCaptionRows?: number;
};

export function useInterpAi(options: UseInterpAiOptions) {
  const [state, setState] = useState<InterpAiState>('closed');
  const [transport, setTransport] = useState<InterpAiTransportState>({ audio: 'none', captions: 'off' });
  const [meeting, setMeeting] = useState<InterpAiMeeting | null>(null);
  const [captions, setCaptions] = useState<InterpAiCaption[]>([]);
  const maxRows = options.maxCaptionRows ?? 50;
  const maxRowsRef = useRef(maxRows);
  maxRowsRef.current = maxRows;

  const client = useMemo(() => new InterpAiClient({
    apiBaseUrl: options.apiBaseUrl,
    showCaptions: options.showCaptions,
    playInBackground: options.playInBackground,
    showCaptionsOnLockScreen: options.showCaptionsOnLockScreen,
    onStateChange: setState,
    onTransportChange: setTransport,
    onMeeting: setMeeting,
    onCaption: caption => {
      setCaptions(previous => {
        if (caption.partial) {
          const index = previous.findIndex(row => row.partial && row.language === caption.language);
          if (index >= 0) {
            const next = previous.slice();
            next[index] = caption;
            return next;
          }
        }
        const withoutPartial = caption.partial
          ? previous
          : previous.filter(row => !(row.partial && row.language === caption.language));
        return [...withoutPartial, caption].slice(-maxRowsRef.current);
      });
    },
  }), [options.apiBaseUrl]);

  useEffect(() => {
    client.setShowCaptions(options.showCaptions ?? true);
  }, [client, options.showCaptions]);

  useEffect(() => {
    client.setShowCaptionsOnLockScreen(options.showCaptionsOnLockScreen ?? false);
  }, [client, options.showCaptionsOnLockScreen]);

  useEffect(() => {
    client.setPlayInBackground(options.playInBackground ?? false);
  }, [client, options.playInBackground]);

  useEffect(() => () => { void client.disconnect(); }, [client]);

  const getMeeting = useCallback(async (accessCode: string) => {
    const found = await client.getMeeting(accessCode);
    setMeeting(found);
    return found;
  }, [client]);

  const getAvailableLanguages = useCallback(
    (accessCode: string) => client.getAvailableLanguages(accessCode),
    [client],
  );

  const connect = useCallback(async (
    accessCode: string,
    language: string,
    captionLanguage?: string,
  ) => {
    setCaptions([]);
    return client.connect({ accessCode, language, captionLanguage });
  }, [client]);

  const disconnect = useCallback(async () => {
    await client.disconnect();
    setCaptions([]);
  }, [client]);

  return {
    client,
    state,
    transport,
    meeting,
    languages: meeting?.languages ?? [],
    captions,
    getMeeting,
    getAvailableLanguages,
    connect,
    disconnect,
    setMuted: (muted: boolean) => client.setMuted(muted),
    setVolume: (volume: number) => client.setVolume(volume),
    wake: () => client.wake(),
  };
}
