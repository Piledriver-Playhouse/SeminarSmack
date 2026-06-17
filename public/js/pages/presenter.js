/**
 * presenter.js — Presenter dashboard logic for SeminarSmack.
 *
 * @module presenter
 */

import {
  getConfigStatus, openRoomChannel, sendBroadcast, closeRoomChannel,
  COOLDOWN_MS, PRESENTER_HEARTBEAT_MS, SNAPSHOT_DEBOUNCE_MS, SUBMISSION_LIMITS,
  loadSessionFromStorage, loadSessionFromFile, saveSessionToStorage,
  sanitizeSimpleToken, sanitizeHostToken, normalizeSessionName,
  validateSession, createPresenterState, createPresenterActivityState,
  getCurrentActivity, getActivityById, getActivityNumber, getResponseTotal,
  isActivityRevealed, getTextMaxLength, clampIndex, clampNumber,
  hashString, stableStringify, humanizeType, escapeHtml, escapeAttribute,
  renderMetricCard, renderEmptyState, setBanner, buildPageUrl,
  signEvent, verifyEventIfNeeded,
  copyText, downloadText,
  buildHostTokenStoreKey, randomToken
} from "../app.js";

export async function initPresenterPage() {
  const params = new URLSearchParams(window.location.search);
  const room = sanitizeSimpleToken(params.get("room"));
  const sessionParam = normalizeSessionName(params.get("session"));
  const hostToken = resolveHostToken(room, params);

  const runtime = {
    page: "present", room, sessionParam, hostToken,
    channel: null, client: null, session: null,
    sessionHash: "", sessionSource: "not loaded",
    presenterState: null, authoringDraft: "",
    bannerMessage: "", bannerTone: "info",
    connectionLabel: "Not connected", connectionTone: "muted",
    snapshotTimer: null, heartbeatId: null,
    knownQuestionIds: new Set(),
    audioPrimed: false
  };

  if (!room) {
    runtime.bannerMessage = "No room code found. Go back and create a session first.";
    runtime.bannerTone = "warning";
  }

  if (!hostToken) {
    runtime.bannerMessage = "Host token missing — presenter controls will be disabled.";
    runtime.bannerTone = "warning";
  }

  // Session loading priority: localStorage → file → error
  if (room && !runtime.session) {
    const stored = loadSessionFromStorage(room);
    if (stored) {
      attachSession(runtime, stored, "Browser session");
    }
  }

  if (!runtime.session && sessionParam) {
    const loaded = await loadSessionFromFile(sessionParam);
    if (loaded.ok) {
      attachSession(runtime, loaded.session, loaded.sourceLabel);
    }
  }

  if (!runtime.session && !runtime.bannerMessage) {
    runtime.bannerMessage = "No session found. Create one first or add ?session=filename to load a JSON file.";
    runtime.bannerTone = "warning";
  }

  const configStatus = getConfigStatus();
  if (!configStatus.ok) {
    runtime.connectionLabel = "Local preview only";
    runtime.connectionTone = "warning";
    if (!runtime.bannerMessage) {
      runtime.bannerMessage = "Realtime is disabled — config.js is not populated.";
      runtime.bannerTone = "warning";
    }
    renderPresenter(runtime);
    return;
  }

  if (!room || !hostToken) { renderPresenter(runtime); return; }

  renderPresenter(runtime);

  try {
    const { channel, client } = await openRoomChannel(room, {
      vote_submitted: async (p) => handleSubmission(runtime, "poll", p),
      quiz_submitted: async (p) => handleSubmission(runtime, "quiz", p),
      text_submitted: async (p) => handleSubmission(runtime, "text", p),
      rating_submitted: async (p) => handleSubmission(runtime, "rate", p),
      kanban_card_submitted: async (p) => handleSubmission(runtime, "kanban", p),
      question_submitted: async (p) => handleQuestionSubmitted(runtime, p),
      activity_changed: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "activity_changed", p);
        if (!ok || !runtime.session || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        runtime.presenterState.currentActivityIndex = clampIndex(Number(p.currentActivityIndex), runtime.session.activities.length);
        runtime.presenterState.submissionsLocked = Boolean(p.submissionsLocked);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      },
      session_reset: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "session_reset", p);
        if (!ok || !runtime.session || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        const activity = getActivityById(runtime.session, p.activityId);
        if (!activity) return;
        resetActivity(runtime, activity, { silent: true, nextResetCount: Number(p.resetCount) || undefined, nextRevision: rev || undefined });
        renderPresenter(runtime);
      },
      submissions_locked: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "submissions_locked", p);
        if (!ok || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        runtime.presenterState.submissionsLocked = Boolean(p.locked);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      },
      reveal_answer: async (p) => {
        const ok = await verifyEventIfNeeded(runtime, "reveal_answer", p);
        if (!ok || !runtime.presenterState) return;
        const rev = Number(p.revision) || 0;
        if (rev < runtime.presenterState.revision) return;
        const aid = String(p.activityId || "");
        if (Boolean(p.revealed)) runtime.presenterState.revealedActivityIds.add(aid);
        else runtime.presenterState.revealedActivityIds.delete(aid);
        runtime.presenterState.revision = rev;
        renderPresenter(runtime);
      }
    });

    runtime.channel = channel;
    runtime.client = client;
    runtime.connectionLabel = "Connected";
    runtime.connectionTone = "success";
    runtime.bannerMessage = "Session is live. Share the student link or QR code when ready.";
    runtime.bannerTone = "success";

    if (runtime.session && runtime.presenterState) {
      await broadcastSnapshot(runtime, "presenter_connected");
      runtime.heartbeatId = window.setInterval(() => { void broadcastSnapshot(runtime, "heartbeat"); }, PRESENTER_HEARTBEAT_MS);
    }
  } catch {
    runtime.connectionLabel = "Connection failed";
    runtime.connectionTone = "warning";
    runtime.bannerMessage = "Could not connect to the realtime channel. Check your Supabase config.";
    runtime.bannerTone = "warning";
  }

  renderPresenter(runtime);
  window.addEventListener("beforeunload", () => {
    if (runtime.snapshotTimer) window.clearTimeout(runtime.snapshotTimer);
    if (runtime.heartbeatId) window.clearInterval(runtime.heartbeatId);
    if (runtime.channel) void closeRoomChannel(runtime.channel);
  });
}

function resolveHostToken(room, params) {
  const urlToken = sanitizeHostToken(params.get("host"));
  const storageKey = buildHostTokenStoreKey(room);

  // The host token is only an informal classroom control guard. It helps avoid
  // casual presenter takeover, but it is not institutional authentication.
  if (urlToken) {
    if (room) window.localStorage.setItem(storageKey, urlToken);
    params.delete("host");
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = params.toString();
    window.history.replaceState({}, "", cleanUrl.toString());
    return urlToken;
  }

  const stored = sanitizeHostToken(window.localStorage.getItem(storageKey));
  if (stored) return stored;

  // Auto-generate a host token when opening a presenter page directly
  // (e.g. the "Try a demo" link) without going through the session builder.
  if (room) {
    const generated = randomToken(32);
    window.localStorage.setItem(storageKey, generated);
    return generated;
  }

  return "";
}

function attachSession(runtime, session, sourceLabel) {
  runtime.session = session;
  runtime.sessionHash = hashString(stableStringify(session));
  runtime.sessionSource = sourceLabel;
  runtime.presenterState = createPresenterState(session);
  runtime.authoringDraft = JSON.stringify(session, null, 2);

  try {
    const stickyStr = window.localStorage.getItem(`seminarsmack:sticky:${runtime.room}`);
    if (stickyStr) {
      const sticky = JSON.parse(stickyStr);
      if (sticky.sessionHash === runtime.sessionHash) {
        runtime.presenterState.currentActivityIndex = clampIndex(Number(sticky.currentActivityIndex), session.activities.length);
        runtime.presenterState.submissionsLocked = Boolean(sticky.submissionsLocked);
        runtime.presenterState.revealedActivityIds = new Set(Array.isArray(sticky.revealedActivityIds) ? sticky.revealedActivityIds : []);
        runtime.presenterState.sessionClosed = Boolean(sticky.sessionClosed);
      }
    }
  } catch {}
}

function saveStickyState(runtime) {
  if (!runtime.room || !runtime.presenterState) return;
  const sticky = {
    sessionHash: runtime.sessionHash,
    currentActivityIndex: runtime.presenterState.currentActivityIndex,
    submissionsLocked: runtime.presenterState.submissionsLocked,
    revealedActivityIds: [...runtime.presenterState.revealedActivityIds],
    sessionClosed: runtime.presenterState.sessionClosed
  };
  window.localStorage.setItem(`seminarsmack:sticky:${runtime.room}`, JSON.stringify(sticky));
}

function resetActivity(runtime, activity, opts = {}) {
  const next = createPresenterActivityState(activity);
  const cur = runtime.presenterState.activityStates[activity.id];
  next.resetCount = opts.nextResetCount || cur.resetCount + 1;
  runtime.presenterState.activityStates[activity.id] = next;
  runtime.presenterState.revealedActivityIds.delete(activity.id);
  runtime.presenterState.revision = opts.nextRevision || runtime.presenterState.revision + 1;
  saveStickyState(runtime);
  if (!opts.silent) { runtime.bannerMessage = "Activity reset."; runtime.bannerTone = "success"; }
}

// ── Rendering ──────────────────────────────────────────────────

function renderPresenter(runtime) {
  const sessionSummary = document.getElementById("session-summary");
  const controlPanel = document.getElementById("control-panel");
  const activityStage = document.getElementById("activity-stage");
  const resultsStage = document.getElementById("results-stage");
  const questionsPanel = document.getElementById("questions-panel");
  const authoringPanel = document.getElementById("authoring-panel");
  const qrPanel = document.getElementById("qr-panel");
  const pageStatus = document.getElementById("page-status");

  const activeJsonInput = document.activeElement?.id === "session-json-input" ? document.activeElement : null;
  const jsonSelStart = typeof activeJsonInput?.selectionStart === "number" ? activeJsonInput.selectionStart : null;
  const jsonSelEnd = typeof activeJsonInput?.selectionEnd === "number" ? activeJsonInput.selectionEnd : null;

  setBanner(pageStatus, runtime.bannerMessage, runtime.bannerTone);

  if (!sessionSummary || !controlPanel || !activityStage || !resultsStage || !questionsPanel || !authoringPanel) return;

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  const actState = activity ? runtime.presenterState?.activityStates[activity.id] : null;
  const disabled = !runtime.hostToken || !runtime.session || !runtime.presenterState;
  const controlsDisabled = disabled || runtime.presenterState?.sessionClosed;
  const canReveal = Boolean(activity && activity.type === "quiz");
  const isRevealed = activity ? isActivityRevealed(runtime.presenterState, activity.id) : false;

  const joinLink = runtime.room ? buildPageUrl("join", { room: runtime.room }) : "";

  // Session summary
  sessionSummary.innerHTML = runtime.session ? `
    <div class="session-meta">
      <div class="summary-row">
        <div>
          <p class="section-kicker">Session loaded</p>
          <h2 class="session-title">${escapeHtml(runtime.session.title)}</h2>
          <p class="body-copy">${escapeHtml(runtime.session.description || "No description.")}</p>
        </div>
        <div class="stack">
          <span class="badge ${runtime.presenterState?.submissionsLocked ? 'badge-locked' : 'badge-open'}">${runtime.presenterState?.submissionsLocked ? 'Submissions closed' : 'Submissions open'}</span>
        </div>
      </div>
      <div class="metric-grid">
        ${renderMetricCard("Room", `<span class="mono">${escapeHtml(runtime.room || "n/a")}</span>`, "Broadcast channel")}
        ${renderMetricCard("Activities", String(runtime.session.activities.length), runtime.sessionSource)}
        ${renderMetricCard("Current", activity ? `${getActivityNumber(runtime.session, activity.id)} / ${runtime.session.activities.length}` : "—", activity ? humanizeType(activity.type) : "None")}
        ${renderMetricCard("Status", escapeHtml(runtime.connectionLabel), runtime.connectionTone === "success" ? "Live" : "Offline")}
        ${renderMetricCard("Questions", String(runtime.presenterState?.questions?.length || 0), "Anonymous")}
      </div>
    </div>
  ` : renderEmptyState("No session loaded", "Create a session first or add ?session=filename to the URL.");

  // QR panel
  if (qrPanel) {
    qrPanel.innerHTML = joinLink ? `
      <div class="qr-panel">
        <p class="section-kicker">📱 Students join here</p>
        <div class="room-code-display">${escapeHtml(runtime.room)}</div>
        <div id="qr-container"></div>
        <p class="body-copy" style="max-width: 360px; margin: 0 auto; font-size: 0.92rem;">Scan the QR code with your phone camera, or open the link below in any browser.</p>
        <div class="stack">
          <div class="copy-row">
            <input id="presenter-join-link" type="text" readonly value="${escapeAttribute(joinLink)}" />
            <button class="button button-ghost" type="button" data-copy-target="presenter-join-link" aria-label="Copy student join link">Copy link</button>
          </div>
        </div>
      </div>
    ` : renderEmptyState("No join link", "A room code is needed to generate the QR code.");
    renderQR(joinLink);
  }

  // Controls
  controlPanel.innerHTML = `
    <div class="controls-shell">
      <p class="section-kicker">Controls</p>
      <div class="control-row">
        <button id="prev-activity" class="button button-ghost" type="button" ${controlsDisabled || !activity || getActivityNumber(runtime.session, activity.id) === 1 ? 'disabled' : ''}>← Previous</button>
        <button id="next-activity" class="button button-primary" type="button" ${controlsDisabled || !activity || getActivityNumber(runtime.session, activity.id) === runtime.session?.activities.length ? 'disabled' : ''}>Next →</button>
        <button id="toggle-lock" class="button button-secondary" type="button" ${controlsDisabled || !activity ? 'disabled' : ''}>${runtime.presenterState?.submissionsLocked ? 'Open submissions' : 'Close submissions'}</button>
        <button id="reset-activity" class="button button-danger" type="button" ${controlsDisabled || !activity ? 'disabled' : ''}>Reset & Allow Resubmission</button>
        <button id="toggle-reveal" class="button button-ghost" type="button" ${controlsDisabled || !canReveal ? 'disabled' : ''}>${isRevealed ? 'Hide answer' : 'Reveal answer'}</button>
        <button id="close-session" class="button button-danger" type="button" ${disabled || runtime.presenterState?.sessionClosed ? 'disabled' : ''}>${runtime.presenterState?.sessionClosed ? 'Session closed' : 'Close session'}</button>
        <button id="export-responses" class="button button-ghost" type="button" ${disabled ? 'disabled' : ''}>Export responses</button>
      </div>

    </div>
  `;

  // Activity stage
  activityStage.innerHTML = activity ? `
    <div class="activity-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Current activity</p>
          <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
        </div>
        <span class="badge badge-accent">Activity ${getActivityNumber(runtime.session, activity.id)} of ${runtime.session.activities.length}</span>
      </div>
      ${renderPresenterPreview(runtime, activity, actState)}
    </div>
  ` : renderEmptyState("No active activity", "Load a session to start.");

  // Results
  const total = activity ? getResponseTotal(activity, actState) : 0;
  resultsStage.innerHTML = activity ? `
    <div class="results-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Results</p>
          <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
        </div>
        <span class="badge badge-accent">${total} response${total === 1 ? '' : 's'}</span>
      </div>
      ${renderResults(runtime, activity, actState)}
    </div>
  ` : renderEmptyState("No results", "Results appear once students submit.");

  questionsPanel.innerHTML = `
    <div class="activity-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Anonymous questions</p>
          <h2 class="activity-title">Live question feed</h2>
        </div>
        <span class="badge badge-accent">${runtime.presenterState?.questions?.length || 0}</span>
      </div>
      ${runtime.presenterState?.questions?.length
        ? `<div class="text-entry-list">${runtime.presenterState.questions.slice().reverse().map((question) => `<article class="text-card"><p>${escapeHtml(question.text)}</p><small>${escapeHtml(new Date(question.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small></article>`).join("")}</div>`
        : renderEmptyState("No questions yet", "Questions from participants will appear here live.")}
    </div>
  `;

  // Authoring
  authoringPanel.innerHTML = `
    <div class="authoring-shell">
      <p class="section-kicker">Session JSON</p>
      <details>
        <summary>Import or export session</summary>
        <div class="stack-lg">
          <label class="field">
            <span>Session JSON</span>
            <textarea id="session-json-input" spellcheck="false">${escapeHtml(runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : ""))}</textarea>
          </label>
          <div class="control-row">
            <button id="load-session-json" class="button button-secondary" type="button">Load JSON</button>
            <button id="copy-session-json" class="button button-ghost" type="button">Copy</button>
            <button id="download-session-json" class="button button-ghost" type="button">Download</button>
          </div>
        </div>
      </details>
    </div>
  `;

  bindInteractions(runtime);

  if (activeJsonInput) {
    const next = document.getElementById("session-json-input");
    next?.focus();
    if (next && typeof jsonSelStart === "number" && typeof jsonSelEnd === "number") {
      next.setSelectionRange(jsonSelStart, jsonSelEnd);
    }
  }
}

function renderQR(url) {
  const container = document.getElementById("qr-container");
  if (!container || !url) return;

  try {
    if (typeof window.qrcode !== "function") throw new Error("QR library not loaded.");
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const img = qr.createImgTag(6, 16);
    container.innerHTML = img;
    const imgEl = container.querySelector("img");
    if (imgEl) {
      imgEl.alt = "QR code to join this session";
      imgEl.style.maxWidth = "280px";
      imgEl.style.width = "100%";
      imgEl.style.height = "auto";
      imgEl.style.borderRadius = "var(--radius-md)";
    }
  } catch {
    container.innerHTML = `<div class="notice notice-info" style="text-align:center;">QR code could not be generated. Students can use the link or room code above instead.</div>`;
  }
}

function renderPresenterPreview(runtime, activity, actState) {
  if (activity.type === "text") {
    return `
      <div class="metric-grid">
        ${renderMetricCard("Responses", String(actState?.texts.length || 0), "Current")}
        ${renderMetricCard("Limit", String(SUBMISSION_LIMITS.text), "Per student")}
        ${renderMetricCard("Max chars", String(getTextMaxLength(activity)), "Per response")}
      </div>
    `;
  }

  if (activity.type === "rate") {
    const ratings = actState?.ratings || [];
    const average = ratings.length ? (ratings.reduce((sum, entry) => sum + entry.rating, 0) / ratings.length).toFixed(1) : "0.0";
    return `
      <div class="metric-grid">
        ${renderMetricCard("Ratings", String(ratings.length), "Submitted")}
        ${renderMetricCard("Average", `${average} / ${activity.maxRating || 5}`, "Live")}
        ${renderMetricCard("Comments", String(ratings.filter((entry) => entry.comment).length), "Optional")}
      </div>
    `;
  }

  if (activity.type === "kanban") {
    return renderKanbanBoard(activity, actState?.cards || []);
  }

  const isRevealed = isActivityRevealed(runtime.presenterState, activity.id);
  return `
    <div class="choice-grid">
      ${activity.options.map((opt, i) => {
        const correct = activity.type === "quiz" && isRevealed && activity.correctIndex === i;
        return `
          <article class="choice-card ${correct ? 'is-correct' : ''}">
            <div class="choice-header">
              <span>${escapeHtml(opt)}</span>
              ${correct ? '<span class="badge badge-open">Correct</span>' : `<span class="badge badge-accent">Option ${i + 1}</span>`}
            </div>
            <div class="choice-meta"><span>${actState?.counts[i] || 0} votes</span></div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderResults(runtime, activity, actState) {
  if (!actState) return renderEmptyState("No results", "Waiting for responses.");

  if (activity.type === "text") {
    const texts = [...actState.texts].reverse();
    return texts.length ? `<div class="text-entry-list">${texts.map((e, i) => `
      <article class="text-card"><p>${escapeHtml(e.text)}</p><small>Response ${texts.length - i}</small></article>
    `).join("")}</div>` : renderEmptyState("No text yet", "Responses appear as students submit.");
  }

  if (activity.type === "rate") {
    const ratings = actState.ratings || [];
    const average = ratings.length ? (ratings.reduce((sum, entry) => sum + entry.rating, 0) / ratings.length).toFixed(1) : "0.0";
    const comments = ratings.filter((entry) => entry.comment);
    return `
      <div class="stack-lg">
        <div class="metric-grid">
          ${renderMetricCard("Average", `${average} / ${activity.maxRating || 5}`, "Live")}
          ${renderMetricCard("Ratings", String(ratings.length), "Submitted")}
          ${renderMetricCard("Comments", String(comments.length), "Optional")}
        </div>
        ${comments.length ? `<div class="text-entry-list">${comments.slice().reverse().map((entry) => `<article class="text-card"><p>${escapeHtml(entry.comment)}</p><small>${"★".repeat(entry.rating)}${"☆".repeat(Math.max((activity.maxRating || 5) - entry.rating, 0))}</small></article>`).join("")}</div>` : renderEmptyState("No comments yet", "Optional comments will appear here.")}
      </div>
    `;
  }

  if (activity.type === "kanban") {
    return renderKanbanBoard(activity, actState.cards || []);
  }

  const revealCorrect = activity.type === "quiz" && isActivityRevealed(runtime.presenterState, activity.id);
  const total = getResponseTotal(activity, actState);
  return `<div class="choice-grid">${activity.options.map((opt, i) => {
    const count = actState.counts[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const correct = revealCorrect && activity.correctIndex === i;
    return `
      <article class="choice-card ${correct ? 'is-correct' : ''}">
        <div class="choice-header"><span>${escapeHtml(opt)}</span><strong>${count}</strong></div>
        <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
        <div class="choice-meta"><span>${pct}%</span><span>${count} response${count === 1 ? '' : 's'}</span></div>
        ${correct ? '<span class="badge badge-open">Correct answer</span>' : ''}
      </article>
    `;
  }).join("")}</div>`;
}

// ── Interactions ───────────────────────────────────────────────

function bindInteractions(runtime) {
  document.getElementById("prev-activity")?.addEventListener("click", () => shiftActivity(runtime, -1));
  document.getElementById("next-activity")?.addEventListener("click", () => shiftActivity(runtime, 1));
  document.getElementById("toggle-lock")?.addEventListener("click", () => toggleLock(runtime));
  document.getElementById("reset-activity")?.addEventListener("click", () => resetCurrent(runtime));
  document.getElementById("toggle-reveal")?.addEventListener("click", () => toggleReveal(runtime));
  document.getElementById("close-session")?.addEventListener("click", () => closeSession(runtime));
  document.getElementById("export-responses")?.addEventListener("click", () => exportResponses(runtime));

  document.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => { runtime.audioPrimed = true; }, { once: true });
  });

  const jsonInput = document.getElementById("session-json-input");
  jsonInput?.addEventListener("input", () => { runtime.authoringDraft = jsonInput.value; });

  document.getElementById("load-session-json")?.addEventListener("click", () => loadFromDraft(runtime));
  document.getElementById("copy-session-json")?.addEventListener("click", async () => {
    const val = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");
    if (val) { try { await copyText(val); setBanner(document.getElementById("page-status"), "JSON copied.", "success"); } catch {} }
  });
  document.getElementById("download-session-json")?.addEventListener("click", () => {
    const val = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");
    if (val) downloadText("session.json", val);
  });
}

async function shiftActivity(runtime, delta) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const cur = getCurrentActivity(runtime.session, runtime.presenterState);
  const ci = cur ? getActivityNumber(runtime.session, cur.id) - 1 : 0;
  const ni = clampIndex(ci + delta, runtime.session.activities.length);
  if (ni === runtime.presenterState.currentActivityIndex) return;
  runtime.presenterState.currentActivityIndex = ni;
  runtime.presenterState.submissionsLocked = false;
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "activity_changed", {
    activityId: runtime.session.activities[ni].id,
    currentActivityIndex: ni, submissionsLocked: false,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "activity_changed");
  renderPresenter(runtime);
}

async function toggleLock(runtime) {
  if (!runtime.presenterState || !runtime.hostToken) return;
  runtime.presenterState.submissionsLocked = !runtime.presenterState.submissionsLocked;
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "submissions_locked", { locked: runtime.presenterState.submissionsLocked, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "lock_toggled");
  renderPresenter(runtime);
}

async function resetCurrent(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity) return;
  resetActivity(runtime, activity);
  await sendPresenterEvent(runtime, "session_reset", { activityId: activity.id, resetCount: runtime.presenterState.activityStates[activity.id].resetCount, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "activity_reset");
  renderPresenter(runtime);
}

async function toggleReveal(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity || activity.type !== "quiz") return;
  const revealed = !runtime.presenterState.revealedActivityIds.has(activity.id);
  if (revealed) runtime.presenterState.revealedActivityIds.add(activity.id);
  else runtime.presenterState.revealedActivityIds.delete(activity.id);
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "reveal_answer", { activityId: activity.id, revealed, revision: runtime.presenterState.revision });
  scheduleSnapshot(runtime, "reveal_toggled");
  renderPresenter(runtime);
}

async function loadFromDraft(runtime) {
  const draft = runtime.authoringDraft || document.getElementById("session-json-input")?.value || "";
  if (!draft.trim()) { runtime.bannerMessage = "Paste valid JSON first."; runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  let raw;
  try { raw = JSON.parse(draft); } catch { runtime.bannerMessage = "Invalid JSON."; runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  const v = validateSession(raw);
  if (!v.ok) { runtime.bannerMessage = v.errors.join(" "); runtime.bannerTone = "warning"; renderPresenter(runtime); return; }
  attachSession(runtime, v.session, "Imported JSON");
  runtime.bannerMessage = "Session loaded from JSON."; runtime.bannerTone = "success";
  renderPresenter(runtime);
  if (runtime.hostToken) await broadcastSnapshot(runtime, "session_imported");
}

// ── Submission handling ────────────────────────────────────────

async function handleSubmission(runtime, expectedType, payload) {
  if (!runtime.session || !runtime.presenterState) return;
  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  if (!activity || activity.type !== expectedType) return;
  if (payload.activityId !== activity.id || runtime.presenterState.submissionsLocked) return;

  const deviceId = sanitizeSimpleToken(payload.deviceId);
  if (!deviceId) return;

  const actState = runtime.presenterState.activityStates[activity.id];
  const entry = actState.submissionsByDevice[deviceId] || { count: 0, lastSubmittedAt: 0, choiceIndex: null, resetCount: actState.resetCount };
  if (Date.now() - entry.lastSubmittedAt < COOLDOWN_MS) return;

  if (expectedType === "text") {
    const text = String(payload.text || "").trim();
    if (!text || text.length > getTextMaxLength(activity) || entry.count >= SUBMISSION_LIMITS.text) return;
    actState.texts.push({ id: `${deviceId}-${Date.now()}`, text, submittedAt: new Date().toISOString() });
  } else if (expectedType === "rate") {
    const rating = clampNumber(payload.rating, 1, activity.maxRating || 5, 0);
    if (!rating || entry.count >= SUBMISSION_LIMITS.rate) return;
    const comment = String(payload.comment || "").trim().slice(0, 280);
    actState.ratings.push({ id: `${deviceId}-${Date.now()}`, rating, comment, submittedAt: new Date().toISOString() });
    entry.choiceIndex = rating - 1;
  } else if (expectedType === "kanban") {
    const text = String(payload.text || "").trim().slice(0, 280);
    const url = String(payload.url || "").trim().slice(0, 1000);
    const columnId = String(payload.columnId || "").trim();
    if (!text || !activity.columns?.some((column) => column.id === columnId) || entry.count >= SUBMISSION_LIMITS.kanban) return;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      } catch {
        return;
      }
    }
    actState.cards.push({ id: `${deviceId}-${Date.now()}`, columnId, text, url, submittedAt: new Date().toISOString() });
  } else {
    const oi = Number(payload.optionIndex);
    if (!Number.isInteger(oi) || oi < 0 || oi >= activity.options.length || entry.count >= SUBMISSION_LIMITS[expectedType]) return;
    actState.counts[oi] = (actState.counts[oi] || 0) + 1;
    entry.choiceIndex = oi;
  }

  entry.count += 1;
  entry.lastSubmittedAt = Date.now();
  entry.resetCount = actState.resetCount;
  actState.submissionsByDevice[deviceId] = entry;
  runtime.presenterState.revision += 1;
  renderPresenter(runtime);
  scheduleSnapshot(runtime, "submission");
}

async function handleQuestionSubmitted(runtime, payload) {
  if (!runtime.presenterState) return;
  const question = normalizeQuestion(payload);
  if (!question || runtime.presenterState.questions.some((entry) => entry.id === question.id)) return;
  runtime.presenterState.questions.push(question);
  runtime.presenterState.revision += 1;
  if (runtime.knownQuestionIds.has(question.id)) return;
  runtime.knownQuestionIds.add(question.id);
  if (runtime.audioPrimed) {
    void playQuestionSound().catch(() => {});
  }
  renderPresenter(runtime);
  scheduleSnapshot(runtime, "question_submitted");
}

// ── Broadcasting ───────────────────────────────────────────────

async function sendPresenterEvent(runtime, name, payload) {
  if (!runtime.channel || !runtime.hostToken) return;
  const signed = await signEvent(name, payload, runtime.hostToken);
  await sendBroadcast(runtime.channel, name, signed);
}

async function broadcastSnapshot(runtime, reason) {
  if (!runtime.channel || !runtime.session || !runtime.presenterState || !runtime.hostToken) return;
  const snap = buildSnapshot(runtime, reason);
  const signed = await signEvent("state_snapshot", snap, runtime.hostToken);
  await sendBroadcast(runtime.channel, "state_snapshot", signed);
}

function scheduleSnapshot(runtime, reason) {
  if (runtime.snapshotTimer) window.clearTimeout(runtime.snapshotTimer);
  runtime.snapshotTimer = window.setTimeout(() => { runtime.snapshotTimer = null; void broadcastSnapshot(runtime, reason); }, SNAPSHOT_DEBOUNCE_MS);
}

function buildSnapshot(runtime, reason) {
  const states = Object.fromEntries(
    Object.entries(runtime.presenterState.activityStates).map(([id, s]) => [id, { counts: [...s.counts], texts: s.texts.map((e) => ({ id: e.id, text: e.text, submittedAt: e.submittedAt })), ratings: s.ratings.map((entry) => ({ ...entry })), cards: s.cards.map((entry) => ({ ...entry })), resetCount: s.resetCount }])
  );
  return {
    reason, revision: runtime.presenterState.revision, session: runtime.session,
    sessionHash: runtime.sessionHash || hashString(stableStringify(runtime.session)),
    currentActivityIndex: runtime.presenterState.currentActivityIndex,
    submissionsLocked: runtime.presenterState.submissionsLocked,
    revealedActivityIds: [...runtime.presenterState.revealedActivityIds],
    activityStates: states,
    questions: runtime.presenterState.questions.map((question) => ({ ...question })),
    sessionClosed: runtime.presenterState.sessionClosed,
    sentAt: new Date().toISOString()
  };
}

async function closeSession(runtime) {
  if (!runtime.presenterState || !runtime.hostToken || runtime.presenterState.sessionClosed) return;
  runtime.presenterState.sessionClosed = true;
  runtime.presenterState.submissionsLocked = true;
  runtime.presenterState.revision += 1;
  saveStickyState(runtime);
  await sendPresenterEvent(runtime, "session_closed", { revision: runtime.presenterState.revision, sessionClosed: true });
  await broadcastSnapshot(runtime, "session_closed");
  runtime.bannerMessage = "Session closed. You can still export responses.";
  runtime.bannerTone = "success";
  renderPresenter(runtime);
}

function exportResponses(runtime) {
  if (!runtime.session || !runtime.presenterState) return;
  const payload = {
    sessionCode: runtime.room,
    sessionTitle: runtime.session.title,
    exportedAt: new Date().toISOString(),
    activities: runtime.session.activities.map((activity) => {
      const state = runtime.presenterState.activityStates[activity.id];
      const base = {
        id: activity.id,
        type: activity.type,
        title: activity.question,
        prompt: activity.prompt || ""
      };
      if (activity.type === "poll" || activity.type === "quiz") {
        return {
          ...base,
          options: activity.options || [],
          counts: [...(state?.counts || [])]
        };
      }
      if (activity.type === "text") {
        return { ...base, responses: state?.texts || [] };
      }
      if (activity.type === "rate") {
        return { ...base, maxRating: activity.maxRating || 5, responses: state?.ratings || [] };
      }
      if (activity.type === "kanban") {
        return { ...base, columns: activity.columns || [], responses: state?.cards || [] };
      }
      return { ...base };
    }),
    questions: runtime.presenterState.questions.map((question) => ({ ...question }))
  };
  downloadText(`seminarsmack-session-${runtime.room || "session"}-responses.json`, JSON.stringify(payload, null, 2));
}

function normalizeQuestion(value) {
  const id = String(value?.id || "").trim();
  const text = String(value?.text || "").trim().slice(0, 280);
  if (!id || !text) return null;
  return { id, text, anonymous: value?.anonymous !== false, submittedAt: String(value?.submittedAt || new Date().toISOString()) };
}

function renderKanbanBoard(activity, cards) {
  return `<div class="kanban-board">${(activity.columns || []).map((column) => {
    const columnCards = cards.filter((card) => card.columnId === column.id).slice().reverse();
    return `<section class="kanban-column"><div class="choice-header"><span>${escapeHtml(column.title)}</span><span class="badge badge-accent">${columnCards.length}</span></div>${columnCards.length ? columnCards.map(renderKanbanCard).join("") : '<div class="notice notice-info">No cards yet.</div>'}</section>`;
  }).join("")}</div>`;
}

function renderKanbanCard(card) {
  const preview = renderUrlPreview(card.url);
  return `<article class="text-card"><p>${escapeHtml(card.text)}</p>${preview}${card.submittedAt ? `<small>${escapeHtml(new Date(card.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</small>` : ""}</article>`;
}

function renderUrlPreview(url) {
  if (!url) return "";
  const safeUrl = escapeAttribute(url);
  if (/\.(gif|png|jpe?g|webp|svg)(\?.*)?$/i.test(url)) {
    return `<div class="media-preview"><img src="${safeUrl}" alt="Card preview" loading="lazy" /></div>`;
  }
  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) {
    return `<div class="media-preview"><video src="${safeUrl}" controls preload="metadata"></video></div>`;
  }
  return `<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></p>`;
}

async function playQuestionSound() {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, context.currentTime);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.05, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.22);
  await new Promise((resolve) => { oscillator.onended = resolve; });
  if (context.state !== "closed") await context.close();
}
