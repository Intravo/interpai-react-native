import React, { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { InterpAiLanguage, InterpAiPlayer, useInterpAi } from '../src';

const API_BASE_URL = 'https://YOUR_INTRAVO_HOST';

export default function App() {
  const sdk = useInterpAi({ apiBaseUrl: API_BASE_URL, showCaptions: true });
  const [code, setCode] = useState('');
  const [selected, setSelected] = useState<InterpAiLanguage | null>(null);

  async function findMeeting() {
    const meeting = await sdk.getMeeting(code);
    setSelected(meeting.languages[0] ?? null);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.eyebrow}>INTRAVO LIVE INTERPRETATION</Text>
      <Text style={styles.title}>{sdk.meeting?.meeting_name ?? 'Listen in your language'}</Text>
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Meeting access code"
          autoCapitalize="characters"
          onChangeText={setCode}
          placeholder="MRK-4820"
          style={styles.input}
          value={code}
        />
        <Pressable onPress={() => void findMeeting()} style={styles.button}>
          <Text style={styles.buttonText}>Find meeting</Text>
        </Pressable>
      </View>
      {sdk.languages.map(language => (
        <Pressable key={language.code} onPress={() => setSelected(language)} style={styles.language}>
          <Text>{language.name}</Text><Text>{language.code}</Text>
        </Pressable>
      ))}
      {selected && (
        <InterpAiPlayer
          apiBaseUrl={API_BASE_URL}
          accessCode={code}
          language={selected.code}
          showCaptions={true}
          style={styles.captions}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, gap: 14, padding: 20, backgroundColor: '#F7F4F2' },
  eyebrow: { color: '#59AE8A', fontSize: 12, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: '#12130F', fontSize: 32, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 10 },
  input: { flex: 1, minHeight: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: '#E0BDEA', borderRadius: 12 },
  button: { justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12, backgroundColor: '#813C8E' },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
  language: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, borderRadius: 12, backgroundColor: '#FFFFFF' },
  captions: { marginTop: 12, padding: 16, borderRadius: 16, backgroundColor: '#FFFFFF' },
});
