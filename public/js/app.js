/**
 * app.js — Thin router and shared utilities for SeminarSmack.
 *
 * Each page loads this module, which detects `data-page` on `<body>`
 * and dynamically imports the correct page module. All shared helpers
 * (escaping, sanitisation, validation, signing, rendering primitives,
 * localStorage session store, room-code generation) live here so that
 * page modules can import them without circular dependencies.
 *
 * @module app
 */

/**
 * @typedef {Object} SessionActivity
 * @property {string} id - Unique identifier for the activity.
 * @property {"poll"|"quiz"|"text"|"rate"|"kanban"} type - Type of the activity.
 * @property {string} question - The main text of the activity.
 * @property {string} [prompt] - Optional supporting prompt text.
 * @property {string[]} [options] - Available options for polls and quizzes.
 * @property {number|null} [correctIndex] - The index of the correct option (quizzes only).
 * @property {number} [maxLength] - Maximum character limit for text responses.
 * @property {number} [maxRating] - Maximum rating value for rate activities.
 * @property {boolean} [comment] - Whether rate activities allow comments.
 * @property {Array<{id: string, title: string}>} [columns] - Configured columns for kanban activities.
 */

/**
 * @typedef {Object} Session
 * @property {string} title - Title of the session.
 * @property {string} description - Optional description.
 * @property {SessionActivity[]} activities - List of activities in the session.
 */

/**
 * @typedef {Object} PresenterActivityState
 * @property {number[]} counts - Array of response counts per option (polls/quizzes).
 * @property {Array<{id: string, text: string, submittedAt: string}>} texts - List of text responses.
 * @property {Array<{id: string, rating: number, comment: string, submittedAt: string}>} ratings - List of ratings.
 * @property {Array<{id: string, columnId: string, text: string, url: string, submittedAt: string}>} cards - List of kanban cards.
 * @property {Object.<string, {count: number, lastSubmittedAt: number, choiceIndex: number|null, resetCount: number}>} submissionsByDevice - Map of device ID to submission record.
 * @property {number} resetCount - Number of times the activity has been reset.
 */

/**
 * @typedef {Object} PresenterState
 * @property {number} revision - The current state revision number.
 * @property {number} currentActivityIndex - The index of the currently active activity.
 * @property {boolean} submissionsLocked - Whether the current activity accepts new submissions.
 * @property {Set<string>} revealedActivityIds - Set of activity IDs whose correct answers have been revealed.
 * @property {Object.<string, PresenterActivityState>} activityStates - Map of activity IDs to their states.
 * @property {Array<{id: string, text: string, anonymous: boolean, submittedAt: string}>} questions - Anonymous questions.
 * @property {boolean} sessionClosed - Whether the presenter has closed the session.
 */

/**
 * @typedef {Object} SharedState
 * @property {number} revision - The current state revision number.
 * @property {number} currentActivityIndex - The index of the currently active activity.
 * @property {boolean} submissionsLocked - Whether the current activity accepts new submissions.
 * @property {Set<string>} revealedActivityIds - Set of activity IDs whose correct answers have been revealed.
 * @property {Object.<string, {counts: number[], texts: Array<{id: string, text: string, submittedAt: string}>, ratings: Array<{id: string, rating: number, comment: string, submittedAt: string}>, cards: Array<{id: string, columnId: string, text: string, url: string, submittedAt: string}>, resetCount: number}>} activityStates - Sanitised public state.
 * @property {Array<{id: string, text: string, anonymous: boolean, submittedAt: string}>} questions - Anonymous questions.
 * @property {boolean} sessionClosed - Whether the presenter has closed the session.
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
export const HOST_TOKEN_STORAGE_PREFIX = "seminarsmack:host-token:";
export const SESSION_STORAGE_PREFIX = "seminarsmack:session:";
export const SUPPORTED_ACTIVITY_TYPES = new Set(["poll", "text", "quiz", "rate", "kanban"]);
export const SUBMISSION_LIMITS = { poll: 1, quiz: 1, text: 2, rate: 1, kanban: 3 };

const ROOM_WORDS = [
  "spark", "chalk", "forum", "scope", "orbit",
  "prism", "atlas", "bloom", "craft", "drift"
];

// ── Page router ──────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  installCopyDelegation();

  const page = document.body.dataset.page;

  if (page === "index") {
    import("./pages/landing.js").then((m) => m.initLandingPage());
    return;
  }
  if (page === "create") {
    import("./pages/session-builder.js").then((m) => m.initCreatePage());
    return;
  }
  if (page === "present") {
    import("./pages/presenter.js").then((m) => m.initPresenterPage());
    return;
  }
  if (page === "join") {
    import("./pages/participant.js").then((m) => m.initJoinPage());
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

/**
 * Generates a human-readable room code using a random word and 4 digits.
 *
 * @returns {string} The generated room code (e.g. "spark-1234").
 */
export function generateRoomCode() {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${word}-${digits}`;
}

/**
 * Generates a random alphanumeric token with Web Crypto.
 *
 * @param {number} [length=32] - The desired length of the token.
 * @returns {string} A random URL-safe token.
 */
export function randomToken(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const cryptoApi = window.crypto || globalThis.crypto;
  const token = [];

  while (token.length < length) {
    const bytes = new Uint8Array(length);
    cryptoApi.getRandomValues(bytes);
    bytes.forEach((byte) => {
      if (token.length < length && byte < 248) {
        token.push(alphabet[byte % alphabet.length]);
      }
    });
  }

  return token.join("");
}

// ── localStorage session store ───────────────────────────────────

/**
 * Saves a session object to localStorage.
 *
 * @param {string} roomCode - The room code used as the storage key.
 * @param {Session} sessionData - The session object to save.
 */
export function saveSessionToStorage(roomCode, sessionData) {
  if (!roomCode || !sessionData) return;
  const key = SESSION_STORAGE_PREFIX + roomCode;
  window.localStorage.setItem(key, JSON.stringify(sessionData));
}

/**
 * Loads and validates a session from localStorage.
 *
 * @param {string} roomCode - The room code to retrieve the session for.
 * @returns {Session|null} The validated session object, or null if invalid/missing.
 */
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

/**
 * Fetches and loads a session from a JSON file in the `sessions/` directory.
 *
 * @param {string} sessionParam - The filename (without .json extension).
 * @returns {Promise<{ok: boolean, session: Session|null, sourceLabel: string, error: Error|null}>} Result object.
 */
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

/**
 * Validates a raw JavaScript object to ensure it meets the Session schema.
 *
 * @param {Object} raw - The raw object to validate.
 * @returns {{ok: boolean, errors: string[], session: Session|null}} Validation result.
 */
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
    errors.push("Every activity must include id, type, and a question or title.");
  }

  const dupes = findDuplicateIds(activities.map((a) => a.id));
  if (dupes.length) errors.push(`Duplicate activity ids: ${dupes.join(", ")}.`);

  activities.forEach((a) => {
    if ((a.type === "poll" || a.type === "quiz") && a.options.length < 2) {
      errors.push(`${a.id} must include at least two options.`);
    }
    if (a.type === "rate" && (a.maxRating < 1 || a.maxRating > 10)) {
      errors.push(`${a.id} has an invalid maxRating.`);
    }
    if (a.type === "kanban" && (!Array.isArray(a.columns) || a.columns.length === 0)) {
      errors.push(`${a.id} must include at least one column.`);
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

/**
 * Normalizes and validates a single activity object.
 *
 * @param {Object} activity - The raw activity object.
 * @param {number} index - The index of the activity in the session.
 * @returns {SessionActivity|null} The normalized activity, or null if invalid.
 */
export function normalizeActivity(activity, index) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null;

  const id = sanitizeActivityId(activity.id, index);
  const type = typeof activity.type === "string" ? activity.type.trim().toLowerCase() : "";
  const question = typeof activity.question === "string" ? activity.question.trim() : "";
  const title = typeof activity.title === "string" ? activity.title.trim() : "";
  const prompt = typeof activity.prompt === "string" ? activity.prompt.trim() : "";
  const primaryQuestion = question || title;

  if (!id || !SUPPORTED_ACTIVITY_TYPES.has(type) || !primaryQuestion) return null;

  const normalized = { id, type, question: primaryQuestion };
  if (prompt) normalized.prompt = prompt;

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

  if (type === "rate") {
    normalized.maxRating = clampNumber(activity.maxRating, 1, 10, 5);
    normalized.comment = Boolean(activity.comment);
  }

  if (type === "kanban") {
    normalized.columns = Array.isArray(activity.columns)
      ? activity.columns
        .map((column, columnIndex) => {
          const columnId = sanitizeActivityId(column?.id || `column-${columnIndex + 1}`, columnIndex);
          const columnTitle = String(column?.title || "").trim();
          if (!columnId || !columnTitle) return null;
          return { id: columnId, title: columnTitle };
        })
        .filter(Boolean)
      : [];
  }

  return normalized;
}

// ── State factories ──────────────────────────────────────────────

/**
 * Creates the initial presenter state for a given session.
 *
 * @param {Session} session - The active session.
 * @returns {PresenterState} The initialized presenter state.
 */
export function createPresenterState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    questions: [],
    sessionClosed: false,
    activityStates: Object.fromEntries(
      session.activities.map((a) => [a.id, createPresenterActivityState(a)])
    )
  };
}

/**
 * Creates the initial presenter state for a single activity.
 *
 * @param {SessionActivity} activity - The activity.
 * @returns {PresenterActivityState} The initialized activity state.
 */
export function createPresenterActivityState(activity) {
  return {
    counts: Array.isArray(activity.options) ? activity.options.map(() => 0) : [],
    texts: [],
    ratings: [],
    cards: [],
    submissionsByDevice: {},
    resetCount: 0
  };
}

/**
 * Creates the initial public shared state for a given session.
 *
 * @param {Session} session - The active session.
 * @returns {SharedState} The initialized public shared state.
 */
export function createPublicState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    questions: [],
    sessionClosed: false,
    activityStates: Object.fromEntries(
      session.activities.map((a) => [
        a.id,
        {
          counts: Array.isArray(a.options) ? a.options.map(() => 0) : [],
          texts: [],
          ratings: [],
          cards: [],
          resetCount: 0
        }
      ])
    )
  };
}

// ── Activity helpers ─────────────────────────────────────────────

/**
 * Retrieves the currently active activity from the session.
 *
 * @param {Session} session - The session object.
 * @param {PresenterState|SharedState} state - The current state object.
 * @returns {SessionActivity|null} The active activity.
 */
export function getCurrentActivity(session, state) {
  if (!session || !state || !Array.isArray(session.activities) || !session.activities.length) return null;
  return session.activities[clampIndex(state.currentActivityIndex, session.activities.length)];
}

/**
 * Retrieves an activity by its ID.
 *
 * @param {Session} session - The session object.
 * @param {string} activityId - The target activity ID.
 * @returns {SessionActivity|null} The matched activity.
 */
export function getActivityById(session, activityId) {
  return session?.activities?.find((a) => a.id === activityId) || null;
}

/**
 * Gets the 1-based index number of an activity.
 *
 * @param {Session} session - The session object.
 * @param {string} activityId - The activity ID.
 * @returns {number} The 1-based index, or 0 if not found.
 */
export function getActivityNumber(session, activityId) {
  const index = session?.activities?.findIndex((a) => a.id === activityId) ?? -1;
  return index >= 0 ? index + 1 : 0;
}

/**
 * Calculates the total number of responses for an activity.
 *
 * @param {SessionActivity} activity - The activity object.
 * @param {PresenterActivityState} activityState - The state for the activity.
 * @returns {number} The total count of responses.
 */
export function getResponseTotal(activity, activityState) {
  if (!activity || !activityState) return 0;
  if (activity.type === "text") return activityState.texts.length;
  if (activity.type === "rate") return activityState.ratings.length;
  if (activity.type === "kanban") return activityState.cards.length;
  return activityState.counts.reduce((sum, c) => sum + c, 0);
}

/**
 * Checks if an activity's answer is currently revealed.
 *
 * @param {PresenterState|SharedState} state - The active state object.
 * @param {string} activityId - The activity ID.
 * @returns {boolean} True if revealed.
 */
export function isActivityRevealed(state, activityId) {
  return Boolean(state?.revealedActivityIds?.has?.(activityId));
}

/**
 * Returns the clamped maximum length for a text activity.
 *
 * @param {SessionActivity} activity - The activity object.
 * @returns {number} The valid max length.
 */
export function getTextMaxLength(activity) {
  return clampNumber(activity?.maxLength, 1, 280, 180);
}

// ── Submission tracking (audience) ───────────────────────────────

/**
 * Creates a local submission tracking record for a participant device.
 *
 * @param {number} [resetCount=0] - Activity reset count this entry belongs to.
 * @returns {{count: number, lastSubmittedAt: number, choiceIndex: number|null, resetCount: number}} Submission entry.
 */
export function createLocalSubmissionEntry(resetCount = 0) {
  return { count: 0, lastSubmittedAt: 0, choiceIndex: null, resetCount };
}

/**
 * Reads the participant's local submission entry for an activity.
 *
 * If the presenter has reset the activity, the local entry is refreshed so the
 * participant can submit again under the new reset count.
 *
 * @param {Object} runtime - Participant page runtime state.
 * @param {string} activityId - Activity identifier.
 * @param {number} resetCount - Current presenter reset count for the activity.
 * @returns {{count: number, lastSubmittedAt: number, choiceIndex: number|null, resetCount: number}} Submission entry.
 */
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

/**
 * Resets the participant's local submission entry for one activity.
 *
 * @param {Object} runtime - Participant page runtime state.
 * @param {string} activityId - Activity identifier.
 * @param {number} resetCount - Current presenter reset count.
 */
export function resetLocalSubmissionEntry(runtime, activityId, resetCount) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  store[activityId] = createLocalSubmissionEntry(resetCount);
  writeSubmissionStore(runtime.submissionStoreKey, store);
}

/**
 * Records a local participant submission or selection update.
 *
 * `countIncrement` is used for actual submitted responses. `choiceIndex` can be
 * updated independently for rating/poll UI state before final submission.
 *
 * @param {Object} runtime - Participant page runtime state.
 * @param {string} activityId - Activity identifier.
 * @param {Object} payload - Local submission update.
 * @param {number} [payload.countIncrement] - Number of submitted responses to add.
 * @param {number} [payload.choiceIndex] - Locally selected choice index.
 */
export function recordLocalSubmission(runtime, activityId, payload) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  const current = store[activityId] || createLocalSubmissionEntry();
  const countIncrement = Number(payload.countIncrement) || 0;
  store[activityId] = {
    ...current,
    count: current.count + countIncrement,
    lastSubmittedAt: countIncrement > 0 ? Date.now() : current.lastSubmittedAt,
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

/**
 * Builds the localStorage key for participant submission limits.
 *
 * The session hash scopes limits to the active session, so reusing a room code
 * with different session content does not inherit old submission counts.
 *
 * @param {string} room - Room code.
 * @param {string} sessionHash - Stable hash of the active session.
 * @returns {string} localStorage key.
 */
export function buildSubmissionStoreKey(room, sessionHash) {
  return `seminarsmack:submissions:${room || "room"}:${sessionHash || "session"}`;
}

/**
 * Builds the localStorage key for a room's presenter host token.
 *
 * @param {string} room - Room code.
 * @returns {string} localStorage key.
 */
export function buildHostTokenStoreKey(room) {
  return HOST_TOKEN_STORAGE_PREFIX + sanitizeSimpleToken(room || "room");
}

// ── Signing / verification ───────────────────────────────────────

/**
 * Signs an event payload with the host token.
 *
 * @param {string} eventName - Name of the event.
 * @param {Object} payload - The payload to sign.
 * @param {string} secret - The host token.
 * @returns {Promise<Object>} The payload containing the `_signature` property.
 */
export async function signEvent(eventName, payload, secret) {
  const signature = await createSignature(`${eventName}:${stableStringify(payload)}`, secret);
  return { ...payload, _signature: signature };
}

/**
 * Verifies an event payload against the host token.
 *
 * @param {string} eventName - Name of the event.
 * @param {Object} payload - The signed payload.
 * @param {string} secret - The host token.
 * @returns {Promise<boolean>} True if the signature is valid.
 */
export async function verifySignedEvent(eventName, payload, secret) {
  if (!payload || typeof payload !== "object") return false;
  const signature = payload._signature;
  if (typeof signature !== "string" || !signature) return false;
  const unsigned = { ...payload };
  delete unsigned._signature;
  const expected = await createSignature(`${eventName}:${stableStringify(unsigned)}`, secret);
  return expected === signature;
}

/**
 * Verifies a signed presenter event when the runtime has a host token.
 *
 * If no host token is present the event is accepted, which preserves local and
 * legacy preview flows where signed presenter control is unavailable.
 *
 * @param {Object} runtime - Page runtime state.
 * @param {string} eventName - Broadcast event name.
 * @param {Object} payload - Event payload.
 * @returns {Promise<boolean>} Whether the event should be accepted.
 */
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

/**
 * Renders an HTML string for a metric card.
 *
 * @param {string} label - The label for the metric.
 * @param {string} value - The primary value to display.
 * @param {string} note - An additional note.
 * @returns {string} The HTML string for the card.
 */
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

/**
 * Renders a standard empty-state block.
 *
 * @param {string} title - Empty-state title.
 * @param {string} body - Empty-state body copy.
 * @returns {string} HTML string.
 */
export function renderEmptyState(title, body) {
  return `
    <div class="empty-state">
      <h2 class="activity-title">${escapeHtml(title)}</h2>
      <p class="body-copy">${escapeHtml(body)}</p>
    </div>
  `;
}

/**
 * Updates a status banner element with a message and tone class.
 *
 * @param {HTMLElement|null} element - Banner element.
 * @param {string} message - Banner text.
 * @param {"info"|"success"|"warning"|"muted"} [tone="info"] - Visual tone suffix.
 */
export function setBanner(element, message, tone = "info") {
  if (!element) return;
  element.textContent = message || "";
  element.className = "status-banner";
  if (message) element.classList.add(`status-${tone}`);
}

// ── DOM helpers ──────────────────────────────────────────────────

/**
 * Copies text to the clipboard, with a textarea fallback for older browsers.
 *
 * @param {string} value - Text to copy.
 * @returns {Promise<void>}
 */
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

/**
 * Temporarily replaces a button label to show immediate feedback.
 *
 * @param {HTMLButtonElement|HTMLElement} button - Button to update.
 * @param {string} text - Temporary label.
 */
export function flashButtonState(button, text) {
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => { button.textContent = original; }, 1400);
}

/**
 * Builds an app page URL relative to the current page.
 *
 * @param {string} pageName - Page basename without `.html`.
 * @param {Object.<string, string>} params - Query parameters to include.
 * @returns {string} Absolute URL string.
 */
export function buildPageUrl(pageName, params) {
  const url = new URL(`./${pageName}.html`, window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url.toString();
}

/**
 * Triggers a download of a text file in the browser.
 *
 * @param {string} filename - The name of the file to save.
 * @param {string} contents - The contents of the file.
 */
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

/**
 * Returns the current browser device ID, creating one if needed.
 *
 * The ID is local to the browser and is used only for lightweight classroom
 * submission limits.
 *
 * @returns {string} Stable local device identifier.
 */
export function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) return existing;
  const next = `device-${randomToken(12)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

// ── Sanitisation & formatting ────────────────────────────────────

/**
 * Sanitizes room codes and simple URL tokens.
 *
 * @param {string} value - Raw token.
 * @returns {string} Lowercase token containing letters, numbers, hyphens, or underscores.
 */
export function sanitizeSimpleToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "") || "";
}

/**
 * Sanitizes presenter host tokens while preserving URL-safe token characters.
 *
 * @param {string} value - Raw host token.
 * @returns {string} Sanitized host token.
 */
export function sanitizeHostToken(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9-_.~]/g, "") || "";
}

/**
 * Normalizes a session file query parameter to a safe basename.
 *
 * @param {string} value - Raw session filename or basename.
 * @returns {string} Safe session basename, or an empty string if invalid.
 */
export function normalizeSessionName(value) {
  const normalized = String(value || "").trim().replace(/\.json$/i, "").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(normalized)) return "";
  return normalized;
}

/**
 * Sanitizes an activity or column ID, falling back to a generated ID.
 *
 * @param {string} value - Raw ID.
 * @param {number} index - Position used for fallback IDs.
 * @returns {string} Safe ID.
 */
export function sanitizeActivityId(value, index) {
  const normalized = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || `activity-${index + 1}`;
}

/**
 * Converts an activity type to a human-readable label.
 *
 * @param {string} type - Activity type.
 * @returns {string} Display label.
 */
export function humanizeType(type) {
  if (type === "quiz") return "Quiz";
  if (type === "text") return "Short text";
  if (type === "rate") return "Rating";
  if (type === "kanban") return "Kanban";
  return "Poll";
}

/**
 * Returns the default participant-page description.
 *
 * @returns {string} Default description.
 */
export function defaultDescription() {
  return "Answer the active prompt and stay synced with the presenter.";
}

// ── Math / data helpers ──────────────────────────────────────────

/**
 * Clamps an index to a valid item position.
 *
 * @param {number} value - Candidate index.
 * @param {number} total - Number of items.
 * @returns {number} Safe zero-based index.
 */
export function clampIndex(value, total) {
  if (!Number.isFinite(value) || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(value)));
}

/**
 * Converts and clamps a number, returning a fallback for invalid input.
 *
 * @param {number|string} value - Candidate number.
 * @param {number} min - Minimum value.
 * @param {number} max - Maximum value.
 * @param {number} fallback - Value used when input is not finite.
 * @returns {number} Clamped integer.
 */
export function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

/**
 * Creates a short deterministic non-cryptographic hash string.
 *
 * @param {string} value - Input value.
 * @returns {string} Hash string prefixed with `s`.
 */
export function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return `s${(hash >>> 0).toString(36)}`;
}

/**
 * Serializes values with stable object key ordering.
 *
 * @param {*} value - Value to serialize.
 * @returns {string} Stable JSON-like string.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Finds duplicate IDs while preserving first-seen uniqueness semantics.
 *
 * @param {string[]} ids - IDs to inspect.
 * @returns {string[]} Duplicate IDs.
 */
export function findDuplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();
  ids.forEach((id) => { if (seen.has(id)) duplicates.add(id); seen.add(id); });
  return [...duplicates];
}

/**
 * Escapes characters in a string to be safely embedded in HTML text content.
 *
 * @param {string} value - The unsafe string.
 * @returns {string} The escaped HTML string.
 */
export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes a string for use in an HTML attribute.
 *
 * @param {string} value - Unsafe string.
 * @returns {string} Attribute-safe string.
 */
export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

/**
 * Returns a trimmed string value or a fallback.
 *
 * @param {string} value - Candidate string.
 * @param {string} fallback - Fallback when the value is empty.
 * @returns {string} Non-empty display string.
 */
export function readOrFallback(value, fallback) {
  return String(value || "").trim() || fallback;
}
