async function checkServer() {
  try {
    const res = await fetch("http://127.0.0.1:8000/health");
    const data = await res.json();
    document.getElementById("server-dot").className =
      "dot " + (data.model_loaded ? "online" : "offline");
    document.getElementById("server-label").textContent =
      data.model_loaded ? "Local model online" : "Model not loaded";
  } catch {
    document.getElementById("server-dot").className = "dot offline";
    document.getElementById("server-label").textContent = "Local server offline";
  }
}

function updateStatus() {
  chrome.runtime.sendMessage({ action: "getStatus" }, (res) => {
    const statusText = document.getElementById("status-text");

    if (chrome.runtime.lastError) {
      statusText.textContent = "Extension background unavailable. Reload MailBlock.";
      return;
    }
    if (!res) return;

    if (res.lastRun) {
      const d = new Date(res.lastRun);
      document.getElementById("last-run").textContent = d.toLocaleString();
    }
    if (res.processed !== undefined) {
      const total = res.total || 0;
      document.getElementById("processed").textContent =
        total > 0 ? `${res.processed} / ${total}` : `${res.processed}`;
    }

    if (res.status === "running") {
      statusText.textContent = "Classifying inbox...";
    } else if (res.status === "done") {
      statusText.textContent = "Inbox classification finished.";
    } else if (res.status === "error") {
      statusText.textContent = res.error || "Something went wrong.";
    } else {
      statusText.textContent = "Idle";
    }
  });
}

document.getElementById("run-btn").addEventListener("click", () => {
  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  btn.textContent = "Starting...";
  document.getElementById("status-text").textContent = "Starting classification...";

  chrome.runtime.sendMessage({ action: "processInbox" }, (res) => {
    btn.disabled = false;
    btn.textContent = "Classify inbox now";

    if (chrome.runtime.lastError) {
      document.getElementById("status-text").textContent =
        "Extension background unavailable. Reload MailBlock.";
      return;
    }

    if (!res?.ok) {
      document.getElementById("status-text").textContent =
        res?.error || "Unable to start mailbox classification.";
    }
    updateStatus();
  });
});

checkServer();
updateStatus();
setInterval(updateStatus, 1500);
