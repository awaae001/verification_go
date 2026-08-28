// Local device profiling. Everything computed here stays in the browser; only
// the derived search starting point influences the proof-of-work order.

export class UnsupportedBrowserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedBrowserError";
  }
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function audioFingerprint() {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) {
    throw new UnsupportedBrowserError("OfflineAudioContext is unavailable");
  }

  const context = new OfflineContext(1, 44100, 44100);
  const oscillator = context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.value = 10000;

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -50;
  compressor.knee.value = 40;
  compressor.ratio.value = 12;
  compressor.attack.value = 0;
  compressor.release.value = 0.25;

  oscillator.connect(compressor);
  compressor.connect(context.destination);
  oscillator.start(0);

  const rendered = await context.startRendering();
  const channel = rendered.getChannelData(0);
  const bytes = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function webGPUFingerprint() {
  if (!navigator.gpu) {
    throw new UnsupportedBrowserError("WebGPU is unavailable");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new UnsupportedBrowserError("no WebGPU adapter");
  }

  let info = adapter.info;
  if (!info && typeof adapter.requestAdapterInfo === "function") {
    info = await adapter.requestAdapterInfo();
  }
  info = info || {};

  const profile = {
    vendor: info.vendor || "",
    architecture: info.architecture || "",
    device: info.device || "",
    description: info.description || "",
    isFallbackAdapter: Boolean(adapter.isFallbackAdapter),
    features: Array.from(adapter.features || []).map(String).sort(),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(profile));
  return toHex(await crypto.subtle.digest("SHA-256", encoded));
}

async function canvasFingerprint() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 96;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new UnsupportedBrowserError("Canvas 2D is unavailable");
  }

  context.fillStyle = "#f4f5f7";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#2563eb");
  gradient.addColorStop(0.5, "#16a34a");
  gradient.addColorStop(1, "#dc2626");
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(48, 48, 31, 0, Math.PI * 2);
  context.bezierCurveTo(105, 8, 155, 88, 214, 30);
  context.lineTo(286, 78);
  context.lineTo(88, 78);
  context.closePath();
  context.fill("evenodd");

  context.globalCompositeOperation = "multiply";
  context.fillStyle = "rgba(255, 196, 0, 0.72)";
  context.fillRect(112.5, 17.5, 142.25, 54.25);
  context.globalCompositeOperation = "source-over";

  context.font = '18px Arial, "Noto Sans", sans-serif';
  context.textBaseline = "alphabetic";
  context.fillStyle = "#111827";
  context.fillText("Human verification ✓ 123", 18, 60);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return toHex(await crypto.subtle.digest("SHA-256", pixels));
}

async function visualFingerprint() {
  try {
    return await webGPUFingerprint();
  } catch (error) {
    console.debug("[page][device] WebGPU unavailable; using Canvas 2D", error);
    return canvasFingerprint();
  }
}

// computeStartOffset derives the proof-of-work search starting point from the
// local audio profile plus WebGPU, falling back to Canvas 2D when WebGPU is not
// available. It throws UnsupportedBrowserError when no usable fallback exists.
export async function computeStartOffset(maximumWork) {
  const audio = await audioFingerprint();
  const visual = await visualFingerprint();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(audio + visual));
  return new DataView(digest).getUint32(0, false) % maximumWork;
}
