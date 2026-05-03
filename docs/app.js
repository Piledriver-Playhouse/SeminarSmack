/**
 * app.js — Thin router and shared utilities for SeminarSmack.
 *
 * Each page loads this module, which detects `data-page` on <body>
 * and dynamically imports the correct page module.  All shared helpers
 * (escaping, sanitisation, validation, signing, rendering primitives,
 * localStorage session store, room-code generation) live here so that
 * page modules can import them without circular dependencies.
 */

import {
  closeRoomChannel,
  getConfigStatus,
  openRoomChannel,
  sendBroadcast
} from "./supabase.js";

// ── Re-exports for page modules ──────────────────────────────────
export { closeRoomChannel, getConfigStatus, openRoomChannel, sendBroadcast };

// ── Constants ────────────────────────────────────────────────────
export const COOLDOWN_MS = 25000;
export const PRESENTER_HEARTBEAT_MS = 5000;
export const SNAPSHOT_DEBOUNCE_MS = 180;
export const DEVICE_STORAGE_KEY = "seminarsmack:device-id";
export const SESSION_STORAGE_PREFIX = "seminarsmack:session:";
export const SUPPORTED_ACTIVITY_TYPES = new Set(["poll", "text", "quiz"]);
export const SUBMISSION_LIMITS = { poll: 1, quiz: 1, text: 2 };

const ROOM_WORDS = [
  "spark", "chalk", "forum", "scope", "orbit",
  "prism", "atlas", "bloom", "craft", "drift"
];

// ── Page router ──────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  installCopyDelegation();

  const page = document.body.dataset.page;

  if (page === "index") {
    import("./landing.js").then((m) => m.initLandingPage());
    return;
  }
  if (page === "create") {
    import("./session-builder.js").then((m) => m.initCreatePage());
    return;
  }
  if (page === "present") {
    import("./presenter.js").then((m) => m.initPresenterPage());
    return;
  }
  if (page === "join") {
    import("./participant.js").then((m) => m.initJoinPage());
  }
});

// ── Copy delegation (global) ─────────────────────────────────────

function installCopyDelegation() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-target]");
    if (!button) return;

    const targetId = button.getAttribute("data-copy-target");
    const input = targetId ? document.getElementById(targetId) : null;
    const value = input && "value" in input
      ? String(input.value || "")
      : String(input?.textContent || "");

    if (!value) return;

    try {
      await copyText(value);
      flashButtonState(button, "Copied ✓");
    } catch {
      flashButtonState(button, "Copy failed");
    }
  });
}

// ── Room code generation ─────────────────────────────────────────

export function generateRoomCode() {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${word}-${digits}`;
}

export function randomToken(length = 10) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36])
    .join("");
}

// ── localStorage session store ───────────────────────────────────

export function saveSessionToStorage(roomCode, sessionData) {
  if (!roomCode || !sessionData) return;
  const key = SESSION_STORAGE_PREFIX + roomCode;
  window.localStorage.setItem(key, JSON.stringify(sessionData));
}

export function loadSessionFromStorage(roomCode) {
  if (!roomCode) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_PREFIX + roomCode);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const validation = validateSession(parsed);
    return validation.ok ? validation.session : null;
  } catch {
    return null;
  }
}

// ── Session file loader (backwards compat) ───────────────────────

export async function loadSessionFromFile(sessionParam) {
  const name = normalizeSessionName(sessionParam);
  if (!name) {
    return { ok: false, error: new Error("Invalid session file name.") };
  }

  try {
    const response = await fetch(
      `./sessions/${encodeURIComponent(name)}.json`,
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error(`Session file returned ${response.status}.`);
    const json = await response.json();
    const validation = validateSession(json);
    if (!validation.ok) throw new Error(validation.errors.join(" "));
    return { ok: true, session: validation.session, sourceLabel: `${name}.json` };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── Validation ───────────────────────────────────────────────────

export function validateSession(raw) {
  const errors = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Session must be an object."], session: null };
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) errors.push("Session title is required.");

  if (!Array.isArray(raw.activities) || raw.activities.length === 0) {
    errors.push("At least one activity is required.");
  }

  const activities = Array.isArray(raw.activities)
    ? raw.activities.map((a, i) => normalizeActivity(a, i)).filter(Boolean)
    : [];

  if (Array.isArray(raw.activities) && activities.length !== raw.activities.length) {
    errors.push("Every activity must include id, type, and question.");
  }

  const dupes = findDuplicateIds(activities.map((a) => a.id));
  if (dupes.length) errors.push(`Duplicate activity ids: ${dupes.join(", ")}.`);

  activities.forEach((a) => {
    if ((a.type === "poll" || a.type === "quiz") && a.options.length < 2) {
      errors.push(`${a.id} must include at least two options.`);
    }
    if (
      a.type === "quiz" &&
      a.correctIndex !== null &&
      (a.correctIndex < 0 || a.correctIndex >= a.options.length)
    ) {
      errors.push(`${a.id} has an invalid correctIndex.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    session: errors.length === 0
      ? { title, description: typeof raw.description === "string" ? raw.description.trim() : "", activities }
      : null
  };
}

export function normalizeActivity(activity, index) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null;

  const id = sanitizeActivityId(activity.id, index);
  const type = typeof activity.type === "string" ? activity.type.trim().toLowerCase() : "";
  const question = typeof activity.question === "string" ? activity.question.trim() : "";

  if (!id || !SUPPORTED_ACTIVITY_TYPES.has(type) || !question) return null;

  const normalized = { id, type, question };

  if (type === "poll" || type === "quiz") {
    normalized.options = Array.isArray(activity.options)
      ? activity.options.map((o) => String(o || "").trim()).filter(Boolean)
      : [];
  }

  if (type === "text") {
    normalized.maxLength = clampNumber(activity.maxLength, 1, 280, 180);
  }

  if (type === "quiz") {
    normalized.correctIndex = Number.isInteger(activity.correctIndex) ? activity.correctIndex : null;
  }

  return normalized;
}

// ── State factories ──────────────────────────────────────────────

export function createPresenterState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    activityStates: Object.fromEntries(
      session.activities.map((a) => [a.id, createPresenterActivityState(a)])
    )
  };
}

export function createPresenterActivityState(activity) {
  return {
    counts: Array.isArray(activity.options) ? activity.options.map(() => 0) : [],
    texts: [],
    submissionsByDevice: {},
    resetCount: 0
  };
}

export function createPublicState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    activityStates: Object.fromEntries(
      session.activities.map((a) => [
        a.id,
        {
          counts: Array.isArray(a.options) ? a.options.map(() => 0) : [],
          texts: [],
          resetCount: 0
        }
      ])
    )
  };
}

// ── Activity helpers ─────────────────────────────────────────────

export function getCurrentActivity(session, state) {
  if (!session || !state || !Array.isArray(session.activities) || !session.activities.length) return null;
  return session.activities[clampIndex(state.currentActivityIndex, session.activities.length)];
}

export function getActivityById(session, activityId) {
  return session?.activities?.find((a) => a.id === activityId) || null;
}

export function getActivityNumber(session, activityId) {
  const index = session?.activities?.findIndex((a) => a.id === activityId) ?? -1;
  return index >= 0 ? index + 1 : 0;
}

export function getResponseTotal(activity, activityState) {
  if (!activity || !activityState) return 0;
  if (activity.type === "text") return activityState.texts.length;
  return activityState.counts.reduce((sum, c) => sum + c, 0);
}

export function isActivityRevealed(state, activityId) {
  return Boolean(state?.revealedActivityIds?.has?.(activityId));
}

export function getTextMaxLength(activity) {
  return clampNumber(activity?.maxLength, 1, 280, 180);
}

// ── Submission tracking (audience) ───────────────────────────────

export function createLocalSubmissionEntry(resetCount = 0) {
  return { count: 0, lastSubmittedAt: 0, choiceIndex: null, resetCount };
}

export function getLocalSubmissionEntry(runtime, activityId, resetCount) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  const entry = store[activityId] || createLocalSubmissionEntry(resetCount);
  if (entry.resetCount !== resetCount) {
    const fresh = createLocalSubmissionEntry(resetCount);
    store[activityId] = fresh;
    writeSubmissionStore(runtime.submissionStoreKey, store);
    return fresh;
  }
  return entry;
}

export function resetLocalSubmissionEntry(runtime, activityId, resetCount) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  store[activityId] = createLocalSubmissionEntry(resetCount);
  writeSubmissionStore(runtime.submissionStoreKey, store);
}

export function recordLocalSubmission(runtime, activityId, payload) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  const current = store[activityId] || createLocalSubmissionEntry();
  store[activityId] = {
    ...current,
    count: current.count + (payload.countIncrement || 0),
    lastSubmittedAt: Date.now(),
    choiceIndex: typeof payload.choiceIndex === "number" ? payload.choiceIndex : current.choiceIndex
  };
  writeSubmissionStore(runtime.submissionStoreKey, store);
}

function readSubmissionStore(key) {
  if (!key) return {};
  try { return JSON.parse(window.localStorage.getItem(key) || "{}"); }
  catch { return {}; }
}

function writeSubmissionStore(key, value) {
  if (!key) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function buildSubmissionStoreKey(room, sessionHash) {
  return `seminarsmack:submissions:${room || "room"}:${sessionHash || "session"}`;
}

// ── Signing / verification ───────────────────────────────────────

export async function signEvent(eventName, payload, secret) {
  const signature = await createSignature(`${eventName}:${stableStringify(payload)}`, secret);
  return { ...payload, _signature: signature };
}

export async function verifySignedEvent(eventName, payload, secret) {
  if (!payload || typeof payload !== "object") return false;
  const signature = payload._signature;
  if (typeof signature !== "string" || !signature) return false;
  const unsigned = { ...payload };
  delete unsigned._signature;
  const expected = await createSignature(`${eventName}:${stableStringify(unsigned)}`, secret);
  return expected === signature;
}

export async function verifyEventIfNeeded(runtime, eventName, payload) {
  if (!runtime.hostToken) return true;
  return verifySignedEvent(eventName, payload, runtime.hostToken);
}

async function createSignature(message, secret) {
  if (!window.crypto?.subtle) return hashString(`${secret}:${message}`);
  const encoder = new TextEncoder();
  const buffer = await window.crypto.subtle.digest("SHA-256", encoder.encode(`${secret}:${message}`));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Rendering primitives ─────────────────────────────────────────

export function renderMetricCard(label, value, note) {
  return `
    <article class="metric-card">
      <strong>${value}</strong>
      <div class="metric-meta">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(note)}</span>
      </div>
    </article>
  `;
}

export function renderEmptyState(title, body) {
  return `
    <div class="empty-state">
      <h2 class="activity-title">${escapeHtml(title)}</h2>
      <p class="body-copy">${escapeHtml(body)}</p>
    </div>
  `;
}

export function setBanner(element, message, tone = "info") {
  if (!element) return;
  element.textContent = message || "";
  element.className = "status-banner";
  if (message) element.classList.add(`status-${tone}`);
}

// ── DOM helpers ──────────────────────────────────────────────────

export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "absolute";
  helper.style.left = "-9999px";
  document.body.append(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
}

export function flashButtonState(button, text) {
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => { button.textContent = original; }, 1400);
}

export function buildPageUrl(pageName, params) {
  const url = new URL(`./${pageName}.html`, window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

export function downloadText(filename, contents) {
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

// ── Device ID ────────────────────────────────────────────────────

export function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) return existing;
  const next = `device-${randomToken(12)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

// ── Sanitisation & formatting ────────────────────────────────────

export function sanitizeSimpleToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "") || "";
}

export function sanitizeHostToken(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9-_.~]/g, "") || "";
}

export function normalizeSessionName(value) {
  const normalized = String(value || "").trim().replace(/\.json$/i, "").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(normalized)) return "";
  return normalized;
}

export function sanitizeActivityId(value, index) {
  const normalized = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || `activity-${index + 1}`;
}

export function humanizeType(type) {
  if (type === "quiz") return "Quiz";
  if (type === "text") return "Short text";
  return "Poll";
}

export function defaultDescription() {
  return "Answer the active prompt and stay synced with the presenter.";
}

// ── Math / data helpers ──────────────────────────────────────────

export function clampIndex(value, total) {
  if (!Number.isFinite(value) || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(value)));
}

export function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

export function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return `s${(hash >>> 0).toString(36)}`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function findDuplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();
  ids.forEach((id) => { if (seen.has(id)) duplicates.add(id); seen.add(id); });
  return [...duplicates];
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function readOrFallback(value, fallback) {
  return String(value || "").trim() || fallback;
}
