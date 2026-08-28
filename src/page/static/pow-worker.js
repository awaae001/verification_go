// Dedicated Worker that searches one disjoint slice of the SHA-256
// proof-of-work space. A synchronous implementation avoids Web Crypto's
// per-digest Promise and buffer-copy overhead for these very small messages.

const REPORT_EVERY = 4096;
const REPORT_INTERVAL_MILLISECONDS = 100;

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function compress(state, bytes, offset, schedule) {
  for (let index = 0; index < 16; index += 1) {
    const position = offset + index * 4;
    schedule[index] = (
      (bytes[position] << 24)
      | (bytes[position + 1] << 16)
      | (bytes[position + 2] << 8)
      | bytes[position + 3]
    ) >>> 0;
  }

  for (let index = 16; index < 64; index += 1) {
    const previous15 = schedule[index - 15];
    const previous2 = schedule[index - 2];
    const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
    const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
    schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
  }

  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];

  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temporary1 = (h + sum1 + choose + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sum0 + majority) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + temporary1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temporary1 + temporary2) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
  state[4] = (state[4] + e) >>> 0;
  state[5] = (state[5] + f) >>> 0;
  state[6] = (state[6] + g) >>> 0;
  state[7] = (state[7] + h) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function decimalLength(value) {
  if (value === 0) {
    return 1;
  }
  let length = 0;
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 10)) {
    length += 1;
  }
  return length;
}

function writeDecimal(bytes, offset, value, length) {
  let remaining = value;
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    const quotient = Math.floor(remaining / 10);
    bytes[index] = 48 + remaining - quotient * 10;
    remaining = quotient;
  }
}

function matchesDifficulty(state, difficulty) {
  const fullBytes = Math.floor(difficulty / 2);
  for (let index = 0; index < fullBytes; index += 1) {
    const word = state[index >>> 2];
    const shift = 24 - (index & 3) * 8;
    if (((word >>> shift) & 0xff) !== 0) {
      return false;
    }
  }
  if (difficulty % 2 === 0) {
    return true;
  }
  const word = state[fullBytes >>> 2];
  const shift = 24 - (fullBytes & 3) * 8;
  return ((word >>> shift) & 0xf0) === 0;
}

function prepareHasher(challenge) {
  const challengeBytes = new TextEncoder().encode(challenge);
  const prefixState = new Uint32Array(INITIAL_STATE);
  const schedule = new Uint32Array(64);
  let offset = 0;
  while (offset + 64 <= challengeBytes.length) {
    compress(prefixState, challengeBytes, offset, schedule);
    offset += 64;
  }

  const tail = challengeBytes.slice(offset);
  const buffer = new Uint8Array(128);
  buffer.set(tail);
  const state = new Uint32Array(8);

  return (solution, difficulty) => {
    const digits = decimalLength(solution);
    const messageLength = tail.length + digits;
    const paddedLength = messageLength < 56 ? 64 : 128;
    writeDecimal(buffer, tail.length, solution, digits);
    buffer[messageLength] = 0x80;
    buffer.fill(0, messageLength + 1, paddedLength - 8);

    const bitLength = (challengeBytes.length + digits) * 8;
    writeUint32(buffer, paddedLength - 8, Math.floor(bitLength / 0x100000000));
    writeUint32(buffer, paddedLength - 4, bitLength >>> 0);

    state.set(prefixState);
    compress(state, buffer, 0, schedule);
    if (paddedLength === 128) {
      compress(state, buffer, 64, schedule);
    }
    return matchesDifficulty(state, difficulty);
  };
}

function requireSearchInput({ challenge, difficulty, maximumWork, start, count }) {
  if (typeof challenge !== "string") {
    throw new TypeError("challenge must be a string");
  }
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 64) {
    throw new RangeError("difficulty is outside the SHA-256 digest");
  }
  if (!Number.isSafeInteger(maximumWork) || maximumWork < 1) {
    throw new RangeError("maximumWork must be a positive safe integer");
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= maximumWork) {
    throw new RangeError("start is outside the proof-of-work space");
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > maximumWork) {
    throw new RangeError("count is outside the proof-of-work space");
  }
}

function search(input) {
  requireSearchInput(input);
  const { challenge, difficulty, maximumWork, start, count } = input;
  const matches = prepareHasher(challenge);
  let solution = start;
  let lastReport = performance.now();

  for (let completed = 0; completed < count; completed += 1) {
    if (matches(solution, difficulty)) {
      self.postMessage({ type: "complete", solution });
      return;
    }

    solution += 1;
    if (solution === maximumWork) {
      solution = 0;
    }

    const searched = completed + 1;
    if (searched % REPORT_EVERY === 0) {
      const now = performance.now();
      if (now - lastReport >= REPORT_INTERVAL_MILLISECONDS) {
        lastReport = now;
        self.postMessage({ type: "progress", completed: searched });
      }
    }
  }

  self.postMessage({ type: "progress", completed: count });
  self.postMessage({ type: "exhausted" });
}

self.onmessage = (event) => {
  try {
    search(event.data);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: String(error && error.message ? error.message : error),
    });
  }
};
