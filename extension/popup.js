const statusEl = document.getElementById("status");
const checkButton = document.getElementById("check");
function check() {
  statusEl.textContent = "Checking authenticated RPC session…";
  checkButton.disabled = true;
  try {
    chrome.runtime.sendMessage({ type: "RPC_STATUS" }, (result) => {
      const lastError = chrome.runtime.lastError;
      checkButton.disabled = false;
      if (lastError) { statusEl.textContent = `Background unavailable: ${lastError.message}`; return; }
      if (result?.connected) statusEl.textContent = "RPC session connected";
      else statusEl.textContent = result?.error || "RPC not logged in. Open Delhivery RPC and sign in.";
    });
  } catch (e) { checkButton.disabled = false; statusEl.textContent = e.message || "Could not contact extension background."; }
}
checkButton.addEventListener("click", check);
check();
