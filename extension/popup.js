const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LOCAL_API = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 10000;

function setUiStatus(message) {
  document.getElementById("status-text").textContent = message;
}

function setProcessed(processed, total = 0) {
  document.getElementById("processed").textContent =
    total > 0 ? `${processed} / ${total}` : `${processed}`;
}

function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error?.message || `Request failed: ${res.status}`);
      }
      return data;
    })
    .catch((err) => {
      if (err?.name === "AbortError") {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    })
    .finally(() => clearTimeout(timeoutId));
}

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(token);
    });
  });
}

async function getBestAvailableToken() {
  try {
    return await getToken(false);
  } catch {
    return getToken(true);
  }
}

async function fetchMostRecentEmail(token) {
  const params = new URLSearchParams({
    maxResults: "1",
    q: "in:inbox"
  });

  const list = await fetchJson(`${GMAIL_API}/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const message = list.messages?.[0];
  if (!message) {
    return null;
  }

  return fetchJson(
    `${GMAIL_API}/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function classifyEmail(subject, sender, body = "") {
  return fetchJson(`${LOCAL_API}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, sender, body })
  });
}

async function getOrCreateLabel(token, category) {
  const fullName = `MailBlock/${category}`;
  const colors = {
    Spam: { backgroundColor: "#cc3a21", textColor: "#ffffff" },
    Work: { backgroundColor: "#285bac", textColor: "#ffffff" },
    Finance: { backgroundColor: "#0b804b", textColor: "#ffffff" },
    Newsletter: { backgroundColor: "#c6b400", textColor: "#ffffff" },
    Personal: { backgroundColor: "#8e24aa", textColor: "#ffffff" },
    Promotions: { backgroundColor: "#e07000", textColor: "#ffffff" }
  };

  const labels = await fetchJson(`${GMAIL_API}/labels`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const existing = labels.labels?.find((label) => label.name === fullName);
  if (existing) {
    return existing.id;
  }

  const created = await fetchJson(`${GMAIL_API}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: fullName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      color: colors[category] || { backgroundColor: "#999999", textColor: "#ffffff" }
    })
  });

  return created.id;
}

async function applyLabel(token, messageId, labelId) {
  await fetchJson(`${GMAIL_API}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ addLabelIds: [labelId] })
  });
}

async function checkServer() {
  try {
    const data = await fetchJson("http://127.0.0.1:8000/health");
    document.getElementById("server-dot").className =
      "dot " + (data.model_loaded ? "online" : "offline");
    document.getElementById("server-label").textContent =
      data.model_loaded ? "Local model online" : "Model not loaded";
  } catch {
    document.getElementById("server-dot").className = "dot offline";
    document.getElementById("server-label").textContent = "Local server offline";
  }
}

function loadSavedStatus() {
  chrome.storage.local.get(["lastRun", "processed", "status"], (res) => {
    if (res.lastRun) {
      const d = new Date(res.lastRun);
      document.getElementById("last-run").textContent = d.toLocaleString();
    }
    if (res.processed !== undefined) {
      setProcessed(res.processed);
    }

    if (res.status === "done") {
      setUiStatus("Inbox classification finished.");
    } else if (res.status === "error") {
      setUiStatus("Last run failed.");
    } else {
      setUiStatus("Idle");
    }
  });
}

async function classifyMostRecentInboxEmail() {
  const btn = document.getElementById("run-btn");
  btn.disabled = true;
  btn.textContent = "Classifying...";
  setUiStatus("Authorizing Gmail...");
  setProcessed(0, 1);

  try {
    const token = await getBestAvailableToken();
    setUiStatus("Fetching most recent email...");

    const email = await fetchMostRecentEmail(token);
    if (!email) {
      setUiStatus("No inbox emails found.");
      chrome.storage.local.set({
        status: "done",
        processed: 0,
        lastRun: new Date().toISOString()
      });
      return;
    }

    const headers = email.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "";
    const sender = headers.find((h) => h.name === "From")?.value || "";

    setUiStatus("Running local classifier...");
    const result = await classifyEmail(subject, sender);

    setUiStatus(`Applying ${result.category} label...`);
    const labelId = await getOrCreateLabel(token, result.category);
    await applyLabel(token, email.id, labelId);

    chrome.storage.local.set({
      status: "done",
      processed: 1,
      lastRun: new Date().toISOString()
    });

    const d = new Date();
    document.getElementById("last-run").textContent = d.toLocaleString();
    setProcessed(1, 1);
    setUiStatus(`Finished: labeled as ${result.category}.`);
  } catch (err) {
    console.error("MailBlock popup flow error:", err);
    chrome.storage.local.set({
      status: "error",
      processed: 0
    });
    setProcessed(0, 1);
    setUiStatus(err?.message || "Classification failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Classify inbox now";
  }
}

document.getElementById("run-btn").addEventListener("click", classifyMostRecentInboxEmail);

checkServer();
loadSavedStatus();
