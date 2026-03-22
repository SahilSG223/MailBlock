const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LOCAL_API = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 10000;
const RUN_TIMEOUT_MS = 120000;

function setStatus(update) {
  chrome.storage.local.set(update);
}

function getRunState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["status", "lastRun", "processed", "total", "error", "runStartedAt"],
      resolve
    );
  });
}

async function normalizeStatus() {
  const state = await getRunState();
  const startedAt = state.runStartedAt ? Date.parse(state.runStartedAt) : NaN;
  const isStaleRun =
    state.status === "running" &&
    (!startedAt || Number.isNaN(startedAt) || Date.now() - startedAt > RUN_TIMEOUT_MS);

  if (isStaleRun) {
    const normalized = {
      status: "idle",
      error: "",
      processed: 0,
      total: 0,
      runStartedAt: "",
    };
    setStatus(normalized);
    return { ...state, ...normalized };
  }

  return state;
}

normalizeStatus().catch((err) => {
  console.error("MailBlock status normalization error:", err);
  setStatus({
    status: "idle",
    error: "",
    processed: 0,
    total: 0,
    runStartedAt: "",
  });
});

async function logStep(message, extra = {}) {
  console.log("MailBlock:", message, extra);
  return new Promise((resolve) => {
    chrome.storage.local.get(["logs"], ({ logs = [] }) => {
      const nextLogs = [
        ...logs.slice(-19),
        `${new Date().toLocaleTimeString()}: ${message}`
      ];
      chrome.storage.local.set(
        {
          logs: nextLogs,
          lastStep: message,
          ...extra
        },
        resolve
      );
    });
  });
}

// Get OAuth token
async function getToken() {
  await logStep("Requesting Gmail authorization token");
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || `Request failed: ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Fetch only the most recent inbox email
async function fetchEmails(token) {
  await logStep("Fetching the most recent inbox message from Gmail");
  const params = new URLSearchParams({
    maxResults: "1",
    q: "in:inbox"
  });

  const data = await fetchJson(`${GMAIL_API}/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const messages = data.messages || [];
  await logStep(`Fetched ${messages.length} inbox message`);
  return messages;
}

// Get single email details
async function getEmail(token, id) {
  return fetchJson(
    `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// Classify email via local model
async function classifyEmail(subject, sender, body = "") {
  return fetchJson(`${LOCAL_API}/classify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, sender, body })
  });
}

async function loadLabelCache(token) {
  const data = await fetchJson(`${GMAIL_API}/labels`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const cache = {};
  for (const label of data.labels || []) {
    cache[label.name] = label.id;
  }
  return cache;
}

// Get or create a Gmail label
async function getOrCreateLabel(token, name, labelCache) {
  await logStep(`Ensuring label exists for ${name}`);
  const colors = {
    Spam: { backgroundColor: "#cc3a21", textColor: "#ffffff" },
    Work: { backgroundColor: "#285bac", textColor: "#ffffff" },
    Finance: { backgroundColor: "#0b804b", textColor: "#ffffff" },
    Newsletter: { backgroundColor: "#c6b400", textColor: "#ffffff" },
    Personal: { backgroundColor: "#8e24aa", textColor: "#ffffff" },
    Promotions: { backgroundColor: "#e07000", textColor: "#ffffff" },
  };

  const fullName = `MailBlock/${name}`;
  if (labelCache[fullName]) {
    return labelCache[fullName];
  }

  // Create new label
  const label = await fetchJson(`${GMAIL_API}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: fullName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      color: colors[name] || { backgroundColor: "#999999", textColor: "#ffffff" }
    })
  });
  labelCache[fullName] = label.id;
  return label.id;
}

// Apply label to email
async function applyLabel(token, messageId, labelId) {
  await logStep(`Applying label ${labelId} to message ${messageId}`);
  await fetchJson(`${GMAIL_API}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ addLabelIds: [labelId] })
  });
}

// Main function — classify all unread emails
async function processInboxInternal() {
  try {
    setStatus({
      status: "running",
      error: "",
      processed: 0,
      total: 0,
      runStartedAt: new Date().toISOString(),
      lastStep: "Starting mailbox classification",
      logs: []
    });
    await logStep("Mailbox classification started");
    const token = await getToken();
    await logStep("Gmail authorization succeeded");
    const messages = await fetchEmails(token);
    const labelCache = await loadLabelCache(token);
    await logStep("Loaded Gmail label cache");

    let processed = 0;
    const total = messages.length;
    setStatus({ total });
    await logStep(`Found ${total} inbox messages to classify`);

    for (const msg of messages) {
      await logStep(`Loading Gmail message ${msg.id}`);
      const email = await getEmail(token, msg.id);
      const headers = email.payload?.headers || [];
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const sender = headers.find(h => h.name === "From")?.value || "";

      await logStep(`Classifying message ${msg.id}`, {
        currentSubject: subject,
        currentSender: sender
      });
      const result = await classifyEmail(subject, sender);
      await logStep(`Model predicted ${result.category} for message ${msg.id}`);
      const labelId = await getOrCreateLabel(token, result.category, labelCache);
      await applyLabel(token, msg.id, labelId);
      processed++;
      setStatus({ processed, total, status: "running" });
      await logStep(`Processed ${processed} of ${total} messages`);
    }

    setStatus({
      status: "done",
      lastRun: new Date().toISOString(),
      processed,
      total,
      runStartedAt: ""
    });
    await logStep("Mailbox classification completed");
  } catch (err) {
    console.error("MailBlock error:", err);
    setStatus({
      status: "error",
      error: err?.message || "Unknown error",
      runStartedAt: ""
    });
    await logStep(`Error: ${err?.message || "Unknown error"}`);
  }
}

async function processInbox() {
  await Promise.race([
    processInboxInternal(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Mailbox classification timed out")), RUN_TIMEOUT_MS);
    }),
  ]).catch(async (err) => {
    console.error("MailBlock run timeout/error:", err);
    setStatus({
      status: "error",
      error: err?.message || "Unknown error",
      runStartedAt: ""
    });
    await logStep(`Error: ${err?.message || "Unknown error"}`);
  });
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "processInbox") {
    processInbox().catch((err) => {
      console.error("MailBlock start error:", err);
      chrome.storage.local.set({
        status: "error",
        error: err?.message || "Unknown error"
      });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "getStatus") {
    normalizeStatus().then(() => {
      chrome.storage.local.get(
        ["status", "lastRun", "processed", "total", "error"],
        sendResponse
      );
    });
    return true;
  }
});
