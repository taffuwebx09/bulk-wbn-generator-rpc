// Injected only on explicitly allowed local dashboard origins.
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.source !== "BULK_WBN_DASHBOARD"
  ) return;

  const { requestId, type, payload } = event.data;

  try {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const lastError = chrome.runtime.lastError;
      window.postMessage({
        source: "BULK_WBN_EXTENSION",
        requestId,
        response: lastError
          ? { ok: false, error: lastError.message || "Extension service worker did not respond." }
          : response
      }, location.origin);
    });
  } catch (error) {
    window.postMessage({
      source: "BULK_WBN_EXTENSION",
      requestId,
      response: { ok: false, error: error?.message || "Could not contact extension." }
    }, location.origin);
  }
});
