/**
 * Dependency-free SHA-256 for the shared engine.
 *
 * `src/` is copied byte-for-byte into the browser and Android WebView, so a
 * Node-only `node:crypto` import here made an otherwise portable module fail as
 * soon as a browser caller reached it. This small implementation keeps the
 * existing synchronous API used by fixture tooling without introducing a
 * platform branch or a second hashing contract.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('SHA-256 input must be a Uint8Array');
  }

  const hash = new Uint32Array(INITIAL_HASH);
  const words = new Uint32Array(64);
  const inputView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const compress = (view, block) => {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(block + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18)
        ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19)
        ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + upperSigma1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (upperSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  };

  // Compress complete input blocks in place. Only the final one or two padded
  // blocks are copied, so hashing a near-limit log does not allocate a second
  // buffer as large as the log itself.
  const completeBytes = Math.floor(bytes.length / 64) * 64;
  for (let block = 0; block < completeBytes; block += 64) {
    compress(inputView, block);
  }

  const remainder = bytes.length - completeBytes;
  const tail = new Uint8Array(remainder < 56 ? 64 : 128);
  tail.set(bytes.subarray(completeBytes));
  tail[remainder] = 0x80;

  const bitLength = BigInt(bytes.length) * 8n;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tail.length - 8, Number((bitLength >> 32n) & 0xffffffffn));
  tailView.setUint32(tail.length - 4, Number(bitLength & 0xffffffffn));
  for (let block = 0; block < tail.length; block += 64) {
    compress(tailView, block);
  }

  return [...hash].map(value => value.toString(16).padStart(8, '0')).join('');
}
