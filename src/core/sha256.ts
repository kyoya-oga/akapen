const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (n: number, x: number): number => (x >>> n) | (x << (32 - n));

const padMessage = (bytes: Uint8Array): Int32Array => {
  const bitLen = bytes.length * 8;
  const totalBytes = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalBytes - 4, bitLen >>> 0, false);
  const words = new Int32Array(totalBytes / 4);
  Array.from({ length: words.length }).map((_, i) => {
    words[i] = view.getInt32(i * 4, false);
  });
  return words;
};

const expandSchedule = (words: Int32Array, chunkOffset: number): Int32Array => {
  const w = new Int32Array(64);
  Array.from({ length: 16 }).map((_, i) => {
    w[i] = words[chunkOffset + i] ?? 0;
  });
  Array.from({ length: 48 }).map((_, idx) => {
    const i = idx + 16;
    const w15 = w[i - 15] ?? 0;
    const w2 = w[i - 2] ?? 0;
    const s0 = rotr(7, w15) ^ rotr(18, w15) ^ (w15 >>> 3);
    const s1 = rotr(17, w2) ^ rotr(19, w2) ^ (w2 >>> 10);
    w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
  });
  return w;
};

type HashState = readonly [number, number, number, number, number, number, number, number];

const compressChunk = (state: HashState, w: Int32Array): HashState => {
  const finalVars = Array.from({ length: 64 }).reduce<HashState>((vars, _, i) => {
    const [a, b, c, d, e, f, g, h] = vars;
    const s1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) | 0;
    const s0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + maj) | 0;
    return [(temp1 + temp2) | 0, a, b, c, (d + temp1) | 0, e, f, g];
  }, state);

  return [
    (state[0] + finalVars[0]) | 0,
    (state[1] + finalVars[1]) | 0,
    (state[2] + finalVars[2]) | 0,
    (state[3] + finalVars[3]) | 0,
    (state[4] + finalVars[4]) | 0,
    (state[5] + finalVars[5]) | 0,
    (state[6] + finalVars[6]) | 0,
    (state[7] + finalVars[7]) | 0,
  ];
};

export const sha256BytesSync = (bytes: Uint8Array): Uint8Array => {
  const words = padMessage(bytes);
  const initialState: HashState = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const chunkCount = words.length / 16;
  const finalState = Array.from({ length: chunkCount }).reduce<HashState>(
    (state, _, chunkIdx) => compressChunk(state, expandSchedule(words, chunkIdx * 16)),
    initialState,
  );
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  finalState.map((word, i) => outView.setInt32(i * 4, word, false));
  return out;
};

export const sha256HexSync = (bytes: Uint8Array): string =>
  Array.from(sha256BytesSync(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
