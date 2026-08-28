// Telegram Login integration.
//
// The Telegram in-app browser branch does not forward opts.nonce when the SDK
// issues its initial /inapp request, and the OAuth request is already
// established by the time the SDK posts oauth_request.url. The only workable
// place to inject the nonce is the initial /inapp request itself, so both fetch
// and XMLHttpRequest are wrapped before the SDK is loaded.

const SDK_URL = "https://oauth.telegram.org/js/telegram-login.js?5";

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

// prepareTelegramLogin installs the in-app nonce patch, loads the SDK, and
// returns a function that opens the Telegram login flow and resolves with an
// ID token.
export async function prepareTelegramLogin(clientID, nonce) {
  installInAppNoncePatch(nonce);
  await loadSDK();

  const login = window.Telegram && window.Telegram.Login;
  if (!login || typeof login.auth !== "function") {
    throw new Error("the Telegram login SDK did not initialize");
  }

  return function requestIDToken() {
    return new Promise((resolve, reject) => {
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
            reject(new Error("Telegram login was cancelled or returned no token"));
            return;
          }
          resolve(idToken);
        },
      );
    });
  };
}
