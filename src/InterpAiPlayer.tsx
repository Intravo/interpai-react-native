import React, { useEffect } from 'react';
import { StyleProp, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { useInterpAi } from './useInterpAi';
import type { InterpAiCaption, InterpAiState, InterpAiTransportState } from './types';

export type InterpAiPlayerProps = {
  apiBaseUrl: string;
  accessCode: string;
  language: string;
  captionLanguage?: string;
  autoConnect?: boolean;
  showCaptions?: boolean;
  maxCaptionRows?: number;
  style?: StyleProp<ViewStyle>;
  captionStyle?: StyleProp<TextStyle>;
  renderCaption?: (caption: InterpAiCaption) => React.ReactNode;
  onStateChange?: (state: InterpAiState) => void;
  onTransportChange?: (transport: InterpAiTransportState) => void;
};

/**
 * Managed player surface. Set `showCaptions={true}` to render the resilient caption feed; audio is
 * receive-only and needs no RTCView.
 */
export function InterpAiPlayer({
  apiBaseUrl,
  accessCode,
  language,
  captionLanguage,
  autoConnect = true,
  showCaptions = true,
  maxCaptionRows = 8,
  style,
  captionStyle,
  renderCaption,
  onStateChange,
  onTransportChange,
}: InterpAiPlayerProps) {
  const player = useInterpAi({ apiBaseUrl, showCaptions, maxCaptionRows });

  useEffect(() => {
    if (!autoConnect) return;
    void player.connect(accessCode, language, captionLanguage);
    return () => { void player.disconnect(); };
  }, [autoConnect, accessCode, language, captionLanguage, player.connect, player.disconnect]);

  useEffect(() => onStateChange?.(player.state), [onStateChange, player.state]);
  useEffect(() => onTransportChange?.(player.transport), [onTransportChange, player.transport]);

  if (!showCaptions) return null;
  return (
    <View accessibilityLiveRegion="polite" style={[styles.container, style]}>
      {player.captions.map((caption, index) => (
        <React.Fragment key={`${caption.language}:${caption.sequence}:${caption.partial ? 'p' : index}`}>
          {renderCaption
            ? renderCaption(caption)
            : <Text style={[styles.caption, caption.partial && styles.partial, captionStyle]}>{caption.text}</Text>}
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  caption: { color: '#12130F', fontSize: 18, lineHeight: 26 },
  partial: { opacity: 0.68 },
});
