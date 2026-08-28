// Dedicated Worker that searches for a SHA-256 proof-of-work solution.
// Running off the main thread keeps Chromium from reporting "Page Unresponsive"
// while thousands of Web Crypto promises are scheduled.

const BATCH_SIZE = 256;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function search({ challenge, difficulty, maximumWork, startOffset }) {
  const prefix = "0".repeat(difficulty);
  const encoder = new TextEncoder();
  let completed = 0;
  let reported = -1;

  while (completed < maximumWork) {
    const size = Math.min(BATCH_SIZE, maximumWork - completed);
    const solutions = new Array(size);
    const pending = new Array(size);
    for (let index = 0; index < size; index += 1) {
      // The hashed payload is challenge and the decimal solution with no
      // separator; any delimiter here breaks server-side verification.
      const solution = (startOffset + completed + index) % maximumWork;
      solutions[index] = solution;
      pending[index] = crypto.subtle.digest("SHA-256", encoder.encode(challenge + String(solution)));
    }

    const digests = await Promise.all(pending);
    for (let index = 0; index < size; index += 1) {
      if (toHex(digests[index]).startsWith(prefix)) {
        self.postMessage({ type: "progress", percentage: 100 });
        self.postMessage({ type: "complete", solution: solutions[index] });
        return;
      }
    }

    completed += size;
    const percentage = Math.floor((completed / maximumWork) * 1000) / 10;
    if (percentage !== reported) {
      reported = percentage;
      self.postMessage({ type: "progress", percentage });
    }
  }

  self.postMessage({ type: "error", message: "exhausted the proof-of-work search space" });
}

self.onmessage = (event) => {
  search(event.data).catch((error) => {
    self.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
  });
};
