const OPUS_SAMPLE_RATE = 48_000;
const MAX_PACKET_BYTES = 1_275;

export type OpusOggSegment = {
  bytes: Uint8Array;
  currentSamples: number;
};

/** Parse Intravo's [uint16 LE length][Opus packet] segment payload. */
export function parseOpusPackets(payload: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    if (offset + 2 > payload.byteLength) throw new Error('Invalid Opus packet prefix.');
    const length = payload[offset]! | (payload[offset + 1]! << 8);
    offset += 2;
    if (length < 1 || length > MAX_PACKET_BYTES || offset + length > payload.byteLength) {
      throw new Error('Invalid Opus packet length.');
    }
    packets.push(payload.slice(offset, offset + length));
    offset += length;
  }
  if (!packets.length) throw new Error('Empty Opus segment.');
  return packets;
}

/** Decoded sample count from RFC 6716 section 3.1's TOC byte. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (!packet.byteLength) throw new Error('Empty Opus packet.');
  const toc = packet[0]!;
  const config = toc >> 3;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  if (frames < 1 || frames > 48) throw new Error('Invalid Opus frame count.');
  const milliseconds = config < 12
    ? [10, 20, 40, 60][config & 3]!
    : config < 16
      ? [10, 20][config & 1]!
      : [2.5, 5, 10, 20][config & 3]!;
  const samples = Math.round(frames * milliseconds * 48);
  if (samples < 120 || samples > 5_760) throw new Error('Invalid Opus packet duration.');
  return samples;
}

/**
 * Wrap raw Opus packets in a short-lived Ogg Opus stream for the native decoder already shipped
 * by react-native-audio-api. Primer packets warm the stateful codec at a segment boundary; callers
 * discard their decoded output by keeping only currentSamples from the tail of the AudioBuffer.
 */
export function buildOpusOggSegment(
  packets: readonly Uint8Array[],
  primer: readonly Uint8Array[] = [],
): OpusOggSegment {
  if (!packets.length) throw new Error('Empty Opus segment.');
  const currentSamples = packets.reduce((total, packet) => total + opusPacketSamples(packet), 0);
  const all = [...primer, ...packets];
  let granule = 0;
  let pageSequence = 0;
  const serial = 0x49564f31; // "IVO1"; each segment is an independent in-memory stream.
  const pages: Uint8Array[] = [];

  pages.push(oggPage(opusHead(), 0, serial, pageSequence++, 0x02));
  pages.push(oggPage(opusTags(), 0, serial, pageSequence++, 0));
  for (let index = 0; index < all.length; index++) {
    granule += opusPacketSamples(all[index]!);
    const flags = index === all.length - 1 ? 0x04 : 0;
    pages.push(oggPage(all[index]!, granule, serial, pageSequence++, flags));
  }

  return { bytes: concat(pages), currentSamples };
}

function opusHead(): Uint8Array {
  const packet = new Uint8Array(19);
  packet.set(ascii('OpusHead'));
  const view = new DataView(packet.buffer);
  packet[8] = 1;
  packet[9] = 1;
  view.setUint16(10, 0, true);
  view.setUint32(12, OPUS_SAMPLE_RATE, true);
  view.setInt16(16, 0, true);
  packet[18] = 0;
  return packet;
}

function opusTags(): Uint8Array {
  const vendor = ascii('Intravo InterpAI');
  const packet = new Uint8Array(8 + 4 + vendor.length + 4);
  packet.set(ascii('OpusTags'));
  const view = new DataView(packet.buffer);
  view.setUint32(8, vendor.length, true);
  packet.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return packet;
}

function oggPage(
  packet: Uint8Array,
  granule: number,
  serial: number,
  sequence: number,
  flags: number,
): Uint8Array {
  const lacing: number[] = [];
  let remaining = packet.byteLength;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  lacing.push(remaining);
  const page = new Uint8Array(27 + lacing.length + packet.byteLength);
  page.set(ascii('OggS'));
  page[4] = 0;
  page[5] = flags;
  const view = new DataView(page.buffer);
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 0x1_0000_0000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(packet, 27 + lacing.length);
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000_0000 ? (crc << 1) ^ 0x04c1_1db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
