# SeminarSmack API Documentation

Welcome to the technical documentation for SeminarSmack.

SeminarSmack is a static, zero-backend web application that uses Supabase Realtime Broadcast to synchronize state between a presenter and multiple participants.

The canonical live API reference is available at https://seminar-smack.com/api/.

Use the navigation menu on the right to explore the core modules and shared utilities that power the application.

## Module Map

- `app` is the shared core. It owns routing, session validation, activity normalization, presenter/public state factories, local submission tracking, signing helpers, rendering primitives, URL builders, sanitization, escaping, and small data helpers.
- `supabase` wraps the Supabase browser client and exposes the realtime channel helpers used by the presenter and participant pages.
- `sessionBuilder` powers `create.html`. It builds session JSON in the browser, saves drafts to `localStorage`, stores the host token, and redirects to the presenter page.
- `presenter` powers `present.html`. It loads a session, maintains the authoritative presenter state, accepts participant submissions, signs control events, broadcasts state snapshots, and exports responses.
- `participant` powers `join.html`. It connects to a room, applies presenter snapshots, enforces per-device submission limits, and sends participant submissions.
- `landing` powers the homepage only.

## Session Schema

A session is a plain JSON object with a `title`, optional `description`, and one or more `activities`.

Each activity must include:

- `id`: stable unique activity identifier.
- `type`: one of `poll`, `quiz`, `text`, `rate`, or `kanban`.
- `question` or `title`: the prompt shown to participants.
- `prompt`: optional supporting text.

Type-specific fields:

- `poll`: `options`, with at least two non-empty strings.
- `quiz`: `options`, with at least two non-empty strings, and optional `correctIndex`.
- `text`: optional `maxLength`, clamped from 1 to 280.
- `rate`: optional `maxRating`, clamped from 1 to 10, and optional `comment`.
- `kanban`: `columns`, each with an `id` and `title`.

`validateSession()` and `normalizeActivity()` in the `app` module are the canonical schema implementation.

## Realtime Protocol

SeminarSmack uses Supabase Realtime Broadcast channels named `room:<room-code>`.

Presenter-owned control events are signed with the host token:

- `activity_changed`
- `session_reset`
- `submissions_locked`
- `reveal_answer`
- `session_closed`
- `state_snapshot`

Participant events are sent to the presenter:

- `vote_submitted`
- `quiz_submitted`
- `text_submitted`
- `rating_submitted`
- `kanban_card_submitted`
- `question_submitted`

The presenter is the source of truth. Participants can render legacy session files when a `session` query parameter is present, but live state is synchronized from signed presenter snapshots.

## State Model

Presenter state stores the full live session, including response counts, text answers, ratings, kanban cards, anonymous questions, reveal state, lock state, reset counts, and session closure.

Public participant state is derived from presenter snapshots. It excludes presenter-only submission tracking and host-token details, but includes enough information for participants to render current prompts, results, reset state, questions, and closed-session messages.

## Storage Keys

Browser storage is intentionally lightweight:

- `seminarsmack:session:<room>` stores locally authored sessions.
- `seminarsmack:host-token:<room>` stores the presenter host token on the presenter device.
- `seminarsmack:submissions:<room>:<session-hash>` stores per-device submission limits.
- `seminarsmack:device-id` stores the participant device identifier.
- `seminarsmack:draft-session` stores the session builder draft.

These values are classroom convenience controls, not institutional authentication or durable assessment records.

## Generated Reference

Run `npm run docs` or `npm run build` to regenerate this reference into `public/api/`. The GitHub Pages workflow runs the same command before publishing, so the live API reference reflects the JSDoc comments in `public/js/`.
