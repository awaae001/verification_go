// Telegram Login integration.
//
// The Telegram in-app browser branch does not forward opts.nonce when the SDK
// issues its initial /inapp request, and the OAuth request is already
// established by the time the SDK posts oauth_request.url. The only workable
// place to inject the nonce is the initial /inapp request itself, so both fetch
// and XMLHttpRequest are wrapped before the SDK is loaded.

const SDK_URL = "https://oauth.telegram.org/js/telegram-login.js?5";
const IN_APP_READY_TIMEOUT = 5000;
const LOGIN_TIMEOUT = 60000;

export class TelegramLoginError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "TelegramLoginError";
    this.reason = reason;
  }
}

function patchedURL(rawURL, nonce) {
  if (!window.TelegramWebviewProxy) {
    return null;
  }
  let url;
  try {
    url = new URL(rawURL, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== "https://oauth.telegram.org" || url.pathname !== "/inapp") {
    return null;
  }
  if (!url.searchParams.has("client_id")) {
    return null;
  }
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

function installInAppNoncePatch(nonce) {
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (resource, options) {
      if (typeof resource === "string") {
        const patched = patchedURL(resource, nonce);
        if (patched) {
          return originalFetch.call(this, patched, options);
        }
      } else if (resource instanceof Request) {
        const patched = patchedURL(resource.url, nonce);
        if (patched) {
          return originalFetch.call(this, new Request(patched, resource), options);
        }
      }
      return originalFetch.call(this, resource, options);
    };
  }

  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, rawURL, ...rest) {
    const patched = typeof rawURL === "string" ? patchedURL(rawURL, nonce) : null;
    return originalOpen.call(this, method, patched || rawURL, ...rest);
  };
}

function loadSDK() {
  if (window.Telegram && window.Telegram.Login) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("failed to load the Telegram login SDK"));
    document.head.appendChild(script);
  });
}

function waitForInAppSupport() {
  if (!window.TelegramWebviewProxy) {
    return Promise.resolve();
  }

  const telegram = window.Telegram;
  const receivers = telegram && [telegram.WebView, telegram.TelegramGameProxy]
    .filter((receiver) => receiver && typeof receiver.receiveEvent === "function");
  if (!receivers || receivers.length === 0) {
    return Promise.reject(new TelegramLoginError(
      "unavailable",
      "Telegram login did not initialize in this browser",
    ));
  }

  return new Promise((resolve, reject) => {
    const restorers = [];
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const restore of restorers) {
        restore();
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    for (const receiver of receivers) {
      const original = receiver.receiveEvent;
      const wrapped = function (eventType, eventData) {
        const result = original.call(this, eventType, eventData);
        if (eventType === "oauth_supported") {
          finish(null);
        }
        return result;
      };
      receiver.receiveEvent = wrapped;
      restorers.push(() => {
        if (receiver.receiveEvent === wrapped) {
          receiver.receiveEvent = original;
        }
      });
    }

    timer = setTimeout(() => {
      finish(new TelegramLoginError(
        "unavailable",
        "Telegram login is not available in this browser",
      ));
    }, IN_APP_READY_TIMEOUT);

    try {
      window.TelegramWebviewProxy.postEvent("oauth_request", "{}");
    } catch (error) {
      finish(new TelegramLoginError(
        "unavailable",
        error && error.message ? error.message : "Telegram login is not available",
      ));
    }
  });
}

// prepareTelegramLogin installs the in-app nonce patch, loads the SDK, and
// returns a function that opens the Telegram login flow and resolves with an
// ID token.
export async function prepareTelegramLogin(clientID, nonce) {
  installInAppNoncePatch(nonce);
  await loadSDK();
  await waitForInAppSupport();

  const login = window.Telegram && window.Telegram.Login;
  if (!login || typeof login.auth !== "function") {
    throw new Error("the Telegram login SDK did not initialize");
  }

  return function requestIDToken() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, idToken) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(idToken);
        }
      };
      const timer = setTimeout(() => {
        finish(new TelegramLoginError(
          "timeout",
          "Telegram login timed out",
        ));
      }, LOGIN_TIMEOUT);

      try {
        login.auth(
          {
            client_id: clientID,
            scope: "profile write",
            lang: "en",
            nonce,
          },
          (result) => {
            const idToken = result && (result.id_token || result.idToken);
            if (!idToken) {
              // Full SDK payloads are debug-only: they may carry account details.
              console.debug("[page][telegram] login did not return an ID token", result);
              finish(new TelegramLoginError(
                "cancelled",
                "Telegram login was cancelled or returned no token",
              ));
              return;
            }
            finish(null, idToken);
          },
        );
      } catch (error) {
        finish(new TelegramLoginError(
          "unavailable",
          error && error.message ? error.message : "Telegram login is not available",
        ));
      }
    });
  };
}
