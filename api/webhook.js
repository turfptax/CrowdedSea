/**
 * CrowdedSea — Vercel Serverless Function: GitHub Webhook → Discord + Slack broadcast.
 *
 * Listens for:
 *   - issues.labeled  (bounty-* label added)
 *   - pull_request.closed (merged → bounty complete)
 *
 * Deploy: `vercel --prod` from repo root (api/ directory auto-detected).
 * Set env vars in Vercel dashboard: GITHUB_WEBHOOK_SECRET, DISCORD_WEBHOOK_URL, SLACK_WEBHOOK_URL
 */

const crypto = require("crypto");

// ── Retry logic for fetch requests ──────────────
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second base delay
const TIMEOUT_MS = 5000; // 5 second timeout

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const isTimeout = error.name === 'AbortError';

      if (isLastAttempt) {
        console.error(`Fetch failed after ${retries} attempts:`, error.message);
        throw error;
      }

      const delay = RETRY_DELAY_MS * attempt; // Exponential backoff
      console.warn(`Attempt ${attempt}/${retries} failed (${isTimeout ? 'timeout' : error.message}), retrying in ${delay}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ── Signature verification ──────────────────────
function verifySignature(body, signature, secret) {
  if (!secret) return true; // skip in dev
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body, "utf-8");
  const expected = "sha256=" + hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Notifiers ───────────────────────────────────
async function postDiscord(content) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function broadcast(message) {
  await Promise.all([postDiscord(message), postSlack(message)]);
}

// ── Main handler ────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // Verify GitHub signature
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const sig = req.headers["x-hub-signature-256"] || "";
  if (!verifySignature(rawBody, sig, process.env.GITHUB_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  const event = req.headers["x-github-event"];
  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  // ── New bounty label added ──
  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name || "";
    if (label.startsWith("bounty-")) {
      const issue = payload.issue;
      const repo = payload.repository.full_name;
      const msg =
        `🌊 **CrowdedSea — New Bounty Live!**\n` +
        `**Repo:** ${repo}\n` +
        `**Issue:** [#${issue.number} — ${issue.title}](${issue.html_url})\n` +
        `**Label:** \`${label}\`\n` +
        `Horizon's packed with galleons. Who's claiming? ⛵`;

      await broadcast(msg);
      return res.status(200).json({ ok: true, action: "bounty_broadcast" });
    }
  }

  // ── PR merged (bounty complete) ──
  if (event === "pull_request" && payload.action === "closed" && payload.pull_request.merged) {
    const pr = payload.pull_request;
    const repo = payload.repository.full_name;
    const hasBountyLabel = (pr.labels || []).some((l) => l.name.startsWith("bounty-"));

    if (hasBountyLabel) {
      const msg =
        `⛵ **CrowdedSea — Bounty Claimed & Merged!**\n` +
        `**Repo:** ${repo}\n` +
        `**PR:** [#${pr.number} — ${pr.title}](${pr.html_url})\n` +
        `**Merged by:** ${pr.merged_by?.login || "unknown"}\n` +
        `Payout pending on-chain. Bang. 💰`;

      await broadcast(msg);
      return res.status(200).json({ ok: true, action: "bounty_completed" });
    }
  }

  return res.status(200).json({ ok: true, action: "ignored" });
};
