export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
export interface AudioWindow { pcm: Buffer; startMs: number; endMs: number; rms: number; final: boolean }

/** Bounded mono PCM16 ring; rejects partial samples rather than corrupting alignment. */
export class AudioRingBuffer {
  readonly #buffer: Buffer;
  #writeAt = 0;
  #length = 0;
  constructor(capacityMs: number) {
    if (!Number.isInteger(capacityMs) || capacityMs < 1) throw new Error("Audio buffer capacity must be a positive integer in ms");
    this.#buffer = Buffer.alloc(capacityMs * BYTES_PER_MS);
  }
  push(pcm: Buffer): void {
    if (pcm.length % 2) throw new Error("PCM16 data must contain complete samples");
    if (pcm.length >= this.#buffer.length) {
      pcm.copy(this.#buffer, 0, pcm.length - this.#buffer.length);
      this.#writeAt = 0; this.#length = this.#buffer.length;
      return;
    }
    const first = Math.min(pcm.length, this.#buffer.length - this.#writeAt);
    pcm.copy(this.#buffer, this.#writeAt, 0, first);
    if (first < pcm.length) pcm.copy(this.#buffer, 0, first);
    this.#writeAt = (this.#writeAt + pcm.length) % this.#buffer.length;
    this.#length = Math.min(this.#buffer.length, this.#length + pcm.length);
  }
  read(): Buffer {
    const start = (this.#writeAt - this.#length + this.#buffer.length) % this.#buffer.length;
    const first = this.#buffer.subarray(start, Math.min(this.#buffer.length, start + this.#length));
    return Buffer.concat([first, this.#buffer.subarray(0, this.#length - first.length)]);
  }
}

export function rms(pcm: Buffer): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let index = 0; index < pcm.length; index += 2) sum += (pcm.readInt16LE(index) / 32768) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

export function encodeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function* rollingWindows(source: AsyncIterable<Buffer>, options: { windowMs?: number; stepMs?: number } = {}): AsyncGenerator<AudioWindow> {
  const windowMs = options.windowMs ?? 5000, stepMs = options.stepMs ?? 1500;
  if (![windowMs, stepMs].every(value => Number.isInteger(value) && value >= 250 && value <= 30_000) || stepMs > windowMs) {
    throw new Error("Audio step/window must be integers between 250 and 30000 ms, with step <= window");
  }
  const ring = new AudioRingBuffer(windowMs);
  const stepBytes = stepMs * BYTES_PER_MS;
  let totalBytes = 0, lastEmitted = 0, nextBoundary = stepBytes, carry = Buffer.alloc(0);
  for await (const chunk of source) {
    let data = Buffer.concat([carry, chunk]);
    carry = data.length % 2 ? Buffer.from(data.subarray(-1)) : Buffer.alloc(0);
    if (data.length % 2) data = data.subarray(0, -1);
    let offset = 0;
    while (offset < data.length) {
      const length = Math.min(data.length - offset, nextBoundary - totalBytes);
      ring.push(data.subarray(offset, offset + length));
      offset += length; totalBytes += length;
      if (totalBytes === nextBoundary) {
        const pcm = ring.read();
        yield { pcm, startMs: (totalBytes - pcm.length) / BYTES_PER_MS, endMs: totalBytes / BYTES_PER_MS, rms: rms(pcm), final: false };
        lastEmitted = totalBytes;
        nextBoundary += stepBytes;
      }
    }
  }
  if (carry.length) throw new Error("Audio input ended with an incomplete PCM16 sample");
  if (totalBytes > lastEmitted) {
    const pcm = ring.read();
    yield { pcm, startMs: (totalBytes - pcm.length) / BYTES_PER_MS, endMs: totalBytes / BYTES_PER_MS, rms: rms(pcm), final: true };
  }
}
