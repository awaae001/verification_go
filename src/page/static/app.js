import { prepareTelegramLogin } from "./telegram.js";
import { computeStartOffset, UnsupportedBrowserError } from "./fingerprint.js";

const config = JSON.parse(document.getElementById("page-config").textContent);

const elements = {
  turnstileWidget: document.getElementById("turnstile-widget"),
  telegramWidget: document.getElementById("telegram-widget"),
  telegramButton: document.getElementById("telegram-button"),
  powWidget: document.getElementById("pow-widget"),
  powProgress: document.getElementById("pow-progress"),
  powProgressBar: document.getElementById("pow-progress-bar"),
  powProgressValue: document.getElementById("pow-progress-value"),
  status: document.getElementById("status"),
  outcome: document.getElementById("outcome"),
  outcomeText: document.getElementById("outcome-text"),
  retryButton: document.getElementById("retry-button"),
};

const session = {
  antiBotToken: "",
  nonce: "",
  powToken: "",
  challenge: "",
  startOffset: 0,
  turnstileWidgetID: null,
  worker: null,
  requestIDToken: null,
};

const TERMINAL_MESSAGES = {
  SESSION_NOT_FOUND: "This verification session no longer exists. Ask the bot for a new link.",
  SESSION_EXPIRED: "This verification session has expired. Ask the bot for a new link.",
  ANTIBOT_REQUIRED: "This verification session is no longer valid. Ask the bot for a new link.",
  STATE_CONFLICT: "This verification session is no longer valid. Ask the bot for a new link.",
  TURNSTILE_UNAVAILABLE: "The anti-bot service is unavailable. Please try again later.",
  TELEGRAM_KEY_UNAVAILABLE: "Telegram verification is unavailable. Please try again later.",
  INTERNAL_ERROR: "The verification service failed. Please try again later.",
};

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

async function post(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (session.antiBotToken) {
    headers["X-Anti-Bot-Token"] = session.antiBotToken;
  }
  let response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(config.session_id)}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError("NETWORK_ERROR", String(error && error.message ? error.message : error));
  }
  if (response.status === 204) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (payload && payload.code) || "INTERNAL_ERROR";
    const message = (payload && payload.info && payload.info.message) || "request failed";
    throw new ApiError(code, message);
  }
  return payload;
}

function setStep(name, status) {
  const step = document.getElementById(`step-${name}`);
  if (step) {
    step.dataset.status = status;
  }
}

function setStatus(text) {
  elements.status.textContent = text;
}

function showOutcome(kind, text, retry) {
  elements.outcome.hidden = false;
  elements.outcome.dataset.kind = kind;
  elements.outcomeText.textContent = text;
  elements.retryButton.hidden = !retry;
  elements.retryButton.onclick = retry || null;
}

function terminate(code, fallback) {
  stopWorker();
  elements.telegramWidget.hidden = true;
  elements.turnstileWidget.hidden = true;
  elements.powWidget.hidden = true;
  setStatus("Verification stopped.");
  showOutcome("error", TERMINAL_MESSAGES[code] || fallback, null);
}

function stopWorker() {
  if (session.worker) {
    session.worker.terminate();
    session.worker = null;
  }
}

function setProgress(percentage) {
  elements.powProgressBar.style.width = `${percentage}%`;
  elements.powProgress.setAttribute("aria-valuenow", String(percentage));
  elements.powProgressValue.textContent = `${percentage.toFixed(1)}%`;
}

function handleFailure(step, error, retry) {
  console.debug(`[page][${step}] failed`, error);
  setStep(step, "failed");
  if (!(error instanceof ApiError)) {
    showOutcome("error", error.message || "Verification failed.", retry);
    setStatus("Verification failed.");
    return;
  }
  if (retry && (error.code === "NETWORK_ERROR" || !TERMINAL_MESSAGES[error.code])) {
    showOutcome("error", error.message, retry);
    setStatus("Verification failed.");
    return;
  }
  terminate(error.code, error.message);
}

function startTurnstile() {
  window.onloadTurnstileCallback = () => {
    session.turnstileWidgetID = window.turnstile.render("#turnstile-widget", {
      sitekey: config.turnstile_site_key,
      action: config.turnstile_action,
      callback: (token) => {
        submitTurnstile(token);
      },
      "error-callback": () => {
        setStep("turnstile", "failed");
        setStatus("Verification failed.");
        showOutcome("error", "The anti-bot check could not be completed.", resetTurnstile);
      },
      "expired-callback": () => {
        resetTurnstile();
      },
    });
  };

  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit";
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    setStep("turnstile", "failed");
    showOutcome("error", "The anti-bot script could not be loaded.", null);
  };
  document.head.appendChild(script);
}

function resetTurnstile() {
  elements.outcome.hidden = true;
  elements.telegramWidget.hidden = true;
  setStep("turnstile", "active");
  setStep("telegram", "waiting");
  setStatus("Waiting for the anti-bot check.");
  if (session.turnstileWidgetID !== null) {
    window.turnstile.reset(session.turnstileWidgetID);
  }
}

async function submitTurnstile(token) {
  setStatus("Checking the anti-bot response.");
  try {
    const result = await post("/antibot", { token });
    session.antiBotToken = result.antibot_token;
    session.nonce = result.nonce;
  } catch (error) {
    handleFailure("turnstile", error, error.code === "TURNSTILE_FAILED" ? resetTurnstile : null);
    return;
  }
  setStep("turnstile", "done");
  elements.turnstileWidget.hidden = true;
  await startTelegram();
}

async function startTelegram() {
  setStep("telegram", "active");
  setStatus("Preparing Telegram login.");
  try {
    session.requestIDToken = await prepareTelegramLogin(config.telegram_client_id, session.nonce);
  } catch (error) {
    handleFailure("telegram", error, null);
    return;
  }
  elements.outcome.hidden = true;
  elements.telegramWidget.hidden = false;
  setStatus("Sign in with Telegram to continue.");
}

async function submitTelegram() {
  elements.telegramButton.disabled = true;
  setStatus("Verifying your Telegram login.");
  try {
    const idToken = await session.requestIDToken();
    const result = await post("/telegram", { nonce: session.nonce, id_token: idToken });
    session.powToken = result.pow_token;
  } catch (error) {
    elements.telegramButton.disabled = false;
    const retry = !(error instanceof ApiError) || error.code === "TELEGRAM_TOKEN_INVALID"
      ? () => {
          elements.outcome.hidden = true;
          setStep("telegram", "active");
          setStatus("Sign in with Telegram to continue.");
        }
      : null;
    handleFailure("telegram", error, retry);
    return;
  }
  setStep("telegram", "done");
  elements.telegramWidget.hidden = true;
  await startFingerprint();
}

async function startFingerprint() {
  setStep("fingerprint", "active");
  setStatus("Profiling this device locally.");

  let challenge;
  try {
    challenge = await post("/challenge", { pow_token: session.powToken });
  } catch (error) {
    handleFailure("fingerprint", error, null);
    return;
  }
  session.challenge = challenge.challenge;

  try {
    session.startOffset = await computeStartOffset(challenge.maximum_work);
  } catch (error) {
    console.debug("[page][fingerprint] failed", error);
    setStep("fingerprint", "failed");
    setStatus("Verification stopped.");
    const message = error instanceof UnsupportedBrowserError
      ? "This browser cannot produce the required local audio or visual profile."
      : "The device profile could not be computed.";
    showOutcome("error", message, null);
    return;
  }
  setStep("fingerprint", "done");
  startProofOfWork(challenge.difficulty, challenge.maximum_work);
}

function startProofOfWork(difficulty, maximumWork) {
  setStep("pow", "active");
  setStatus("Solving the proof of work. Keep this page open.");
  elements.outcome.hidden = true;
  elements.powWidget.hidden = false;
  setProgress(0);

  stopWorker();
  // Resolved against this module, not the page URL, so the worker keeps the
  // versioned asset prefix.
  session.worker = new Worker(new URL("./pow-worker.js", import.meta.url));
  session.worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === "progress") {
      setProgress(message.percentage);
      return;
    }
    if (message.type === "complete") {
      stopWorker();
      submitSolution(message.solution, difficulty, maximumWork);
      return;
    }
    stopWorker();
    setStep("pow", "failed");
    setStatus("Verification failed.");
    showOutcome("error", "The proof of work failed.", () => startProofOfWork(difficulty, maximumWork));
  };
  session.worker.onerror = (event) => {
    console.debug("[page][pow] worker error", event.message);
    stopWorker();
    setStep("pow", "failed");
    setStatus("Verification failed.");
    showOutcome("error", "The proof-of-work worker could not run.", null);
  };
  session.worker.postMessage({
    challenge: session.challenge,
    difficulty,
    maximumWork,
    startOffset: session.startOffset,
  });
}

async function submitSolution(solution, difficulty, maximumWork) {
  setStatus("Submitting the answer for confirmation.");
  try {
    await post("/pow", { challenge: session.challenge, solution });
  } catch (error) {
    // A rejected solution leaves the challenge unconsumed, so restarting the
    // search with the same challenge is safe.
    const retry = !(error instanceof ApiError) || error.code === "POW_SOLUTION_INVALID"
      ? () => startProofOfWork(difficulty, maximumWork)
      : null;
    handleFailure("pow", error, retry);
    return;
  }
  setStep("pow", "done");
  elements.powWidget.hidden = true;
  setStatus("Verification complete.");
  showOutcome("success", "Verification complete. Return to the bot and confirm.", null);
}

elements.telegramButton.addEventListener("click", () => {
  submitTelegram();
});

startTurnstile();
