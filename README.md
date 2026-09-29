# InterpAI React Native SDK

Add Intravo live interpreted audio, meeting languages, and captions to an existing React Native
app. The SDK owns the complete listener transport ladder, so an app does not have to recreate the
behavior used by Intravo's hosted listener.

## What it includes

- meeting validation and the exact languages available for that meeting;
- receive-only WebRTC audio with server-issued STUN and TURN credentials;
- TURN/TCP/TLS support on port 443 when supplied by the Intravo server;
- WebSocket backup transport, then SSE, then the durable HTTPS event poll;
- native HTTPS PCM playback when WebRTC is unavailable on a restricted network;
- captions with cross-transport cursor handoff and final-caption deduplication;
- independent audio and caption languages;
- bounded retry, language switching, mute, volume, and explicit server cleanup;
- no microphone capture, camera capture, or `RTCView`.

The socket normally carries compact Opus audio. React Native builds that do not install an optional
Opus decoder leave those frames unclaimed and immediately use the matching HTTPS PCM segment. This
preserves audio on restricted networks without giving an app microphone permissions.

## Install from GitHub

Until the first npm release is published:

```bash
npm install github:Intravo/interpai-react-native#v0.1.0 \
  react-native-webrtc@^124.0.8 \
  react-native-audio-api@^0.13.6
cd ios && pod install && cd ..
```

This package contains native dependencies. Use a React Native native build or an Expo development
build; Expo Go cannot load it.

## Managed component

```tsx
import { InterpAiPlayer } from '@intravo/interpai-react-native';

export function MeetingAudio() {
  return (
    <InterpAiPlayer
      apiBaseUrl="https://YOUR_INTRAVO_HOST"
      accessCode="MRK-4820"
      language="es"
      showCaptions={true}
      onTransportChange={({ audio, captions }) => {
        console.log({ audio, captions });
      }}
    />
  );
}
```

`showCaptions={true}` renders caption rows and keeps them current across WebSocket, SSE, and poll
handoffs. Setting it to `false` hides and suppresses caption callbacks; it does not disable the event
transport because that same transport discovers restricted-network audio segments.

## Hook for a custom interface

```tsx
import { useInterpAi } from '@intravo/interpai-react-native';

const player = useInterpAi({
  apiBaseUrl: 'https://YOUR_INTRAVO_HOST',
  showCaptions: true,
});

const meeting = await player.getMeeting(accessCode);
// meeting.languages is the authoritative list for this meeting.

await player.connect(accessCode, meeting.languages[0].code);
```

The hook exposes `languages`, `captions`, `state`, `transport`, `setMuted`, `setVolume`, `wake`, and
`disconnect`. Call `wake()` when the app receives a network-recovery signal or returns to the
foreground.

## Headless client

```ts
import { InterpAiClient } from '@intravo/interpai-react-native';

const client = new InterpAiClient({
  apiBaseUrl: 'https://YOUR_INTRAVO_HOST',
  showCaptions: true,
  onCaption: caption => renderCaption(caption),
  onTransportChange: transport => updateDiagnostics(transport),
});

const meeting = await client.getMeeting(accessCode);
await client.connect({
  accessCode,
  language: meeting.languages[0].code,
  captionLanguage: meeting.languages[0].code,
});
```

## Restricted-network behavior

Audio and captions recover independently:

```text
Audio:    WebRTC (direct or TURN/TCP/TLS 443)
            -> socket PCM when available
            -> HTTPS PCM segments

Captions: WebSocket
            -> Server-Sent Events
            -> HTTPS event poll
```

The HTTPS event poll is the durable floor. It discovers PCM segments and continues to work when a
venue blocks UDP, WebRTC, WebSockets, or long-lived event streams but permits ordinary HTTPS.

## Production gates

- Ask Intravo Corp to allowlist the app's production API origin where applicable.
- Never log access codes, SDP, TURN credentials, caption tickets, or listener session IDs.
- Configure Android audio as media/speech playback and do not request `RECORD_AUDIO`.
- Configure iOS for playback, verify that no microphone indicator appears, and test interruptions,
  Bluetooth routing, lock-screen playback, backgrounding, and network transitions on real devices.
- Call `disconnect()` when the listener leaves. The SDK closes the local peer first and then calls
  the idempotent server leave endpoint.

The authoritative endpoint and wire-format documentation remains with the Intravo Interpretation
server and desktop application.
