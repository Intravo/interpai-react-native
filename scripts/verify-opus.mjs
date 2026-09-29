import { spawnSync } from 'node:child_process';
import { parseOpusPackets, buildOpusOggSegment } from '../src/audio/OpusOgg.ts';

const encoded = spawnSync(
  'ffmpeg',
  [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.7',
    '-filter:a', 'volume=2', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip',
    '-frame_duration', '20', '-f', 'ogg', 'pipe:1',
  ],
  { encoding: null },
);
if (encoded.status !== 0) throw new Error(encoded.stderr.toString());

const sourcePackets = readOggPackets(encoded.stdout).slice(2, 27);
if (sourcePackets.length !== 25) throw new Error('Could not generate 25 Opus packets.');

let primer = [];
for (const [index, packetGroup] of [sourcePackets.slice(0, 12), sourcePackets.slice(12)].entries()) {
  const payload = lengthPrefix(packetGroup);
  const packets = parseOpusPackets(payload);
  const built = buildOpusOggSegment(packets, primer);
  const decodedResult = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'ogg', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
    { input: Buffer.from(built.bytes), encoding: null },
  );
  if (decodedResult.status !== 0) throw new Error(decodedResult.stderr.toString());
  const decoded = new Float32Array(
    decodedResult.stdout.buffer,
    decodedResult.stdout.byteOffset,
    decodedResult.stdout.byteLength / 4,
  );
  if (decoded.length < built.currentSamples) throw new Error(`segment ${index + 1}: short decode`);
  const current = decoded.subarray(decoded.length - built.currentSamples);
  let sumSquares = 0;
  let zeroCrossings = 0;
  for (let sample = 0; sample < current.length; sample++) {
    sumSquares += current[sample] * current[sample];
    if (sample && (current[sample - 1] < 0) !== (current[sample] < 0)) zeroCrossings++;
  }
  const rms = Math.sqrt(sumSquares / current.length);
  const crossingsPerSecond = zeroCrossings * 48_000 / current.length;
  console.log(JSON.stringify({
    segment: index + 1,
    packets: packets.length,
    currentSamples: built.currentSamples,
    decodedSamples: decoded.length,
    rms: Number(rms.toFixed(4)),
    zeroCrossingsPerSecond: Math.round(crossingsPerSecond),
  }));
  if (rms < 0.12 || rms > 0.22 || crossingsPerSecond < 800 || crossingsPerSecond > 1_020) {
    throw new Error(`segment ${index + 1}: decoded signal is outside expected bounds`);
  }
  primer = packets.slice(-2);
}

function lengthPrefix(packets) {
  const bytes = new Uint8Array(packets.reduce((total, packet) => total + 2 + packet.length, 0));
  let offset = 0;
  for (const packet of packets) {
    bytes[offset] = packet.length & 0xff;
    bytes[offset + 1] = packet.length >> 8;
    bytes.set(packet, offset + 2);
    offset += 2 + packet.length;
  }
  return bytes;
}

function readOggPackets(input) {
  const packets = [];
  let pending = [];
  let offset = 0;
  while (offset < input.length) {
    if (input.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Invalid Ogg page.');
    const segmentCount = input[offset + 26];
    const lacing = input.subarray(offset + 27, offset + 27 + segmentCount);
    let bodyOffset = offset + 27 + segmentCount;
    for (const length of lacing) {
      pending.push(input.subarray(bodyOffset, bodyOffset + length));
      bodyOffset += length;
      if (length < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    offset = bodyOffset;
  }
  if (pending.length) throw new Error('Truncated Ogg packet.');
  return packets;
}
