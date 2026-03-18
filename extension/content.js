const LABELS = {
  Spam:        { color: "#ef4444"},
  Work:        { color: "#3b82f6"},
  Finance:     { color: "#10b981"},
  Newsletter:  { color: "#f59e0b"},
  Personal:    { color: "#8b5cf6"},
  Promotions:  { color: "#ec4899"},
};

async function classifyEmail(subject, sender, body) {
  const res = await fetch("http://127.0.0.1:8000/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, sender, body })
  });
  return res.json();
}

function injectBadge(emailRow, category, confidence) {
  if (emailRow.querySelector(".ai-badge")) return;
  const { color, emoji } = LABELS[category] || { color: "#888", emoji: "?" };
  const badge = document.createElement("span");
  badge.className = "ai-badge";
  badge.style.cssText = `
    background:${color}22; color:${color}; border:1px solid ${color}55;
    border-radius:4px; padding:1px 6px; font-size:11px;
    font-weight:500; margin-left:8px; white-space:nowrap;
  `;
  badge.textContent = `${emoji} ${category} ${Math.round(confidence * 100)}%`;
  const subjectEl = emailRow.querySelector(".y6");
  if (subjectEl) subjectEl.appendChild(badge);
}

// Observe Gmail's DOM for new email rows
const observer = new MutationObserver(() => {
  document.querySelectorAll("tr.zA:not([data-classified])").forEach(async row => {
    row.setAttribute("data-classified", "true");
    const subject = row.querySelector(".y6 span")?.textContent || "";
    const sender  = row.querySelector(".yP, .zF")?.textContent || "";
    try {
      const result = await classifyEmail(subject, sender, "");
      injectBadge(row, result.category, result.confidence);
    } catch(e) {
      console.warn("Classifier offline:", e);
    }
  });
});

observer.observe(document.body, { childList: true, subtree: true });