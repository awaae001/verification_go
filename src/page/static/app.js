import { prepareTelegramLogin, TelegramLoginError } from "./telegram.js";
import { computeStartOffset, UnsupportedBrowserError } from "./fingerprint.js";

const config = JSON.parse(document.getElementById("page-config").textContent);

// The server embeds the full message table for the resolved page language
// (merged over English) into the page config, so this lookup is the only
// translation layer the script needs.
const messages = config.messages || {};
function msg(key) {
  const value = messages[key];
  return typeof value === "string" && value !== "" ? value : null;
}

const elements = {
  turnstileWidget: document.getElementById("turnstile-widget"),
  telegramButton: document.getElementById("telegram-button"),
  confirmSpinner: document.getElementById("confirm-spinner"),
  powWidget: document.getElementById("pow-widget"),
  powProgress: document.getElementById("pow-progress"),
  powProgressBar: document.getElementById("pow-progress-bar"),
  powProgressValue: document.getElementById("pow-progress-value"),
  status: document.getElementById("status"),
  outcome: document.getElementById("outcome"),
  outcomeTitle: document.getElementById("outcome-title"),
  outcomeText: document.getElementById("outcome-text"),
  outcomeSession: document.getElementById("outcome-session"),
  outcomeSessionID: document.getElementById("outcome-session-id"),
  retryButton: document.getElementById("retry-button"),
};

const stages = {
  turnstile: document.getElementById("stage-turnstile"),
  telegram: document.getElementById("stage-telegram"),
  confirm: document.getElementById("stage-confirm"),
};

const session = {
  antiBotToken: "",
  nonce: "",
  powToken: "",
  challenge: "",
  startOffset: 0,
  turnstileWidgetID: null,
  turnstilePending: false,
  workers: [],
  requestIDToken: null,
};

// API error codes that leave the session unusable; their messages come from
// the "terminal.<CODE>" i18n keys.
const TERMINAL_CODES = new Set([
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "ANTIBOT_REQUIRED",
  "STATE_CONFLICT",
  "TURNSTILE_UNAVAILABLE",
  "TELEGRAM_KEY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

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

function showStage(name) {
  for (const [key, section] of Object.entries(stages)) {
    section.hidden = key !== name;
  }
}

function hideStages() {
  showStage("");
}

function setStatus(text) {
  elements.status.textContent = text;
}

function showOutcome(kind, text, retry) {
  elements.outcome.hidden = false;
  elements.outcome.dataset.kind = kind;
  elements.outcomeText.textContent = text;
  // Errors get a support-style header and the session ID so users can quote
  // it when asking for help; success stays a single line.
  const isError = kind === "error";
  elements.outcomeTitle.hidden = !isError;
  elements.outcomeSession.hidden = !isError;
  if (isError) {
    elements.outcomeSessionID.textContent = config.session_id;
  }
  elements.retryButton.hidden = !retry;
  elements.retryButton.onclick = retry || null;
}

function terminate(code, fallback) {
  stopWorkers();
  hideStages();
  setStatus(msg("status.stopped"));
  showOutcome("error", msg(`terminal.${code}`) || fallback, null);
}

function stopWorkers() {
  for (const worker of session.workers) {
    worker.terminate();
  }
  session.workers = [];
}

function setProgress(percentage) {
  elements.powProgressBar.style.width = `${percentage}%`;
  elements.powProgress.setAttribute("aria-valuenow", String(percentage));
  elements.powProgressValue.textContent = `${percentage.toFixed(1)}%`;
}

function handleFailure(error, retry) {
  console.debug("[page][verify] failed", error);
  if (!(error instanceof ApiError)) {
    showOutcome("error", error.message || msg("status.failed"), retry);
    setStatus(msg("status.failed"));
    return;
  }
  if (retry && (error.code === "NETWORK_ERROR" || !TERMINAL_CODES.has(error.code))) {
    showOutcome("error", error.message, retry);
    setStatus(msg("status.failed"));
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
        setStatus(msg("status.failed"));
        showOutcome("error", msg("error.turnstile_failed"), resetTurnstile);
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
    setStatus(msg("status.failed"));
    showOutcome("error", msg("error.turnstile_script"), null);
  };
  document.head.appendChild(script);
}

function resetTurnstile() {
  session.turnstilePending = false;
  elements.outcome.hidden = true;
  showStage("turnstile");
  setStatus(msg("status.turnstile_waiting"));
  if (session.turnstileWidgetID !== null) {
    window.turnstile.reset(session.turnstileWidgetID);
  }
}

async function submitTurnstile(token) {
  if (session.turnstilePending || session.antiBotToken) {
    return;
  }
  session.turnstilePending = true;
  setStatus(msg("status.checking"));
  try {
    const result = await post("/antibot", { token });
    session.antiBotToken = result.antibot_token;
    session.nonce = result.nonce;
  } catch (error) {
    session.turnstilePending = false;
    const canRetry = error.code === "TURNSTILE_FAILED" || error.code === "RATE_LIMITED";
    if (error.code === "RATE_LIMITED") {
      error.message = msg("error.turnstile_rate");
    }
    handleFailure(error, canRetry ? resetTurnstile : null);
    return;
  }
  if (session.turnstileWidgetID !== null && window.turnstile && typeof window.turnstile.remove === "function") {
    window.turnstile.remove(session.turnstileWidgetID);
    session.turnstileWidgetID = null;
  }
  await startTelegram();
}

function localizeTelegramError(error) {
  if (!(error instanceof TelegramLoginError)) {
    return error;
  }
  const message = msg(`error.telegram_${error.reason}`);
  return message ? new Error(message) : error;
}

async function startTelegram() {
  setStatus(msg("status.telegram_preparing"));
  try {
    session.requestIDToken = await prepareTelegramLogin(config.telegram_client_id, session.nonce);
  } catch (error) {
    handleFailure(localizeTelegramError(error), null);
    return;
  }
  elements.outcome.hidden = true;
  showStage("telegram");
  setStatus(msg("status.telegram_ready"));
}

async function submitTelegram() {
  elements.telegramButton.disabled = true;
  setStatus(msg("status.telegram_connecting"));
  try {
    const idToken = await session.requestIDToken();
    const result = await post("/telegram", { nonce: session.nonce, id_token: idToken });
    session.powToken = result.pow_token;
  } catch (error) {
    elements.telegramButton.disabled = false;
    const retry = !(error instanceof ApiError) || error.code === "TELEGRAM_TOKEN_INVALID"
      ? () => {
          elements.outcome.hidden = true;
          setStatus(msg("status.telegram_ready"));
        }
      : null;
    handleFailure(localizeTelegramError(error), retry);
    return;
  }
  await startConfirmation();
}

// Fingerprinting and proof of work run back to back without user input, so
// they share one "we are confirming" stage on screen.
async function startConfirmation() {
  showStage("confirm");
  elements.confirmSpinner.hidden = false;
  elements.powWidget.hidden = true;
  setStatus(msg("status.confirming"));

  let challenge;
  try {
    challenge = await post("/challenge", { pow_token: session.powToken });
  } catch (error) {
    handleFailure(error, null);
    return;
  }
  session.challenge = challenge.challenge;

  try {
    session.startOffset = await computeStartOffset(challenge.maximum_work);
  } catch (error) {
    console.debug("[page][fingerprint] failed", error);
    setStatus(msg("status.stopped"));
    const message = error instanceof UnsupportedBrowserError
      ? msg("error.unsupported_browser")
      : msg("error.fingerprint");
    showOutcome("error", message, null);
    return;
  }
  startProofOfWork(challenge.difficulty, challenge.maximum_work);
}

function startProofOfWork(difficulty, maximumWork) {
  setStatus(msg("status.pow"));
  elements.outcome.hidden = true;
  elements.confirmSpinner.hidden = true;
  elements.powWidget.hidden = false;
  setProgress(0);

  stopWorkers();
  const availableCores = Number.isInteger(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 2;
  // More workers have diminishing returns and can make high-core-count devices
  // unresponsive, so use at most eight disjoint search slices.
  const workerCount = Math.max(1, Math.min(availableCores, 8, maximumWork));
  const completedByWorker = new Array(workerCount).fill(0);
  const sliceSize = Math.floor(maximumWork / workerCount);
  const extraSlices = maximumWork % workerCount;
  const workerURL = new URL("./pow-worker.js", import.meta.url);
  let exhaustedWorkers = 0;
  let settled = false;

  function fail(message, retry) {
    if (settled) {
      return;
    }
    settled = true;
    stopWorkers();
    setStatus(msg("status.failed"));
    showOutcome("error", message, retry);
  }

  for (let index = 0; index < workerCount; index += 1) {
    const sliceStart = index * sliceSize + Math.min(index, extraSlices);
    const count = sliceSize + (index < extraSlices ? 1 : 0);
    const distanceToEnd = maximumWork - session.startOffset;
    const start = sliceStart >= distanceToEnd
      ? sliceStart - distanceToEnd
      : session.startOffset + sliceStart;

    let worker;
    try {
      // Resolved against this module, not the page URL, so every worker keeps
      // the versioned asset prefix.
      worker = new Worker(workerURL);
    } catch (error) {
      console.debug("[page][pow] failed to create worker", error);
      fail(msg("error.pow_worker"), null);
      return;
    }
    session.workers.push(worker);

    worker.onmessage = (event) => {
      if (settled) {
        return;
      }
      const message = event.data;
      if (message.type === "progress") {
        completedByWorker[index] = Math.min(message.completed, count);
        const completed = completedByWorker.reduce((sum, value) => sum + value, 0);
        setProgress(Math.min(99.9, (completed / maximumWork) * 100));
        return;
      }
      if (message.type === "complete") {
        settled = true;
        setProgress(100);
        stopWorkers();
        submitSolution(message.solution, difficulty, maximumWork);
        return;
      }
      if (message.type === "exhausted") {
        completedByWorker[index] = count;
        exhaustedWorkers += 1;
        if (exhaustedWorkers === workerCount) {
          fail(msg("error.pow"), () => startProofOfWork(difficulty, maximumWork));
        }
        return;
      }
      console.debug("[page][pow] worker failed", message.message || message.type);
      fail(msg("error.pow"), () => startProofOfWork(difficulty, maximumWork));
    };
    worker.onerror = (event) => {
      console.debug("[page][pow] worker error", event.message);
      fail(msg("error.pow_worker"), null);
    };
    worker.postMessage({
      challenge: session.challenge,
      difficulty,
      maximumWork,
      start,
      count,
    });
  }
}

async function submitSolution(solution, difficulty, maximumWork) {
  setStatus(msg("status.submitting"));
  try {
    await post("/pow", { challenge: session.challenge, solution });
  } catch (error) {
    // A rejected solution leaves the challenge unconsumed, so restarting the
    // search with the same challenge is safe.
    const retry = !(error instanceof ApiError) || error.code === "POW_SOLUTION_INVALID"
      ? () => startProofOfWork(difficulty, maximumWork)
      : null;
    handleFailure(error, retry);
    return;
  }
  hideStages();
  setStatus(msg("status.complete"));
  showOutcome("success", msg("outcome.success"), null);
}

elements.telegramButton.addEventListener("click", () => {
  submitTelegram();
});

startTurnstile();
