# Contributing to SeminarSmack

Thanks for contributing to SeminarSmack.

This project aims to stay:

- Static-first
- Low-cost to run
- Simple to deploy
- Easy for educators to understand and adapt
- Backend-light

When contributing, please try to preserve those goals.

## Principles

- Prefer browser-side solutions over backend-heavy designs.
- Avoid adding required database tables unless there is a strong reason.
- Keep the app compatible with static hosting.
- Reuse the existing session JSON, localStorage, and Supabase Realtime Broadcast patterns where possible.
- Keep UI changes simple, readable, and touch-friendly.
- Avoid introducing large frameworks or build complexity unless the project direction explicitly changes.

## Project layout

Key files and folders:

- `public/index.html` — landing page
- `public/create.html` — session builder
- `public/join.html` — participant page
- `public/present.html` — presenter page
- `public/js/app.js` — shared utilities, validation, state helpers, router
- `public/js/pages/session-builder.js` — builder logic
- `public/js/pages/participant.js` — participant logic
- `public/js/pages/presenter.js` — presenter logic
- `public/js/supabase.js` — Supabase Realtime wrapper
- `public/assets/css/styles.css` — shared styles
- `public/sessions/` — sample session JSON files

## Local development

1. Copy the config template:

```bash
cp public/js/config.template.js public/js/config.js
```

2. Add your Supabase project URL and publishable key to `public/js/config.js`.

3. Serve the `public/` directory with any static server, for example:

```bash
npx serve public
```

4. Open the site locally and test with:

- one presenter window
- one participant window in incognito, a second browser, or a phone

## How the app works

- Sessions are authored as JSON and validated in the browser.
- Presenter state is the source of truth during a live session.
- Live updates are sent over Supabase Realtime Broadcast.
- Participant submissions are tracked with lightweight per-device local limits in `localStorage`.
- The app is designed to work without a traditional backend.

## Adding or changing features

If you add a feature, please check:

- Does it work with static hosting?
- Does it keep the presenter as the source of truth?
- Can it fit into the existing session/activity model?
- Does it avoid unnecessary infrastructure?
- Is the UI understandable for non-technical educators?

For activity changes in particular:

- Update validation and normalization in `public/js/app.js`
- Update presenter and participant rendering
- Update live state snapshot handling
- Update sample session JSON or docs if the feature is user-facing

## Activity conventions

Current activity types include:

- `poll`
- `quiz`
- `text`
- `rate`
- `kanban`

New activity types should stay minimal and should reuse the existing activity/state flow where possible.

## Testing expectations

There is a small automated test suite for shared validation and token helpers, but not a full browser or accessibility suite.

For now, contributions should include:

- `npm run lint`
- `npm test`
- `npm run build` when documentation output may change
- A short manual testing pass
- README updates when behaviour changes
- Sample JSON updates when new activity formats are added

Useful manual checks:

- Presenter and participant pages both update correctly
- Join by QR/direct link still works
- Manual room-code join still works
- Session close/export still works
- Existing activity types are not broken by the change

## Style expectations

- Use the project’s existing plain JavaScript structure.
- Prefer small, readable functions over heavy abstraction.
- Keep comments concise and only where they help.
- Match the existing naming and file organization.
- Favor ASCII unless a file already uses other characters intentionally.
- Do not commit `node_modules/`, local config files, coverage, caches, or generated dependency folders.

## AI-assisted maintenance

This repository is also used as an example of agentic coding. If you use an AI coding assistant:

- Keep changes small and targeted.
- Run `npm run lint`, `npm test`, and `npm run build` before committing.
- Do not commit generated dependency folders or local environment/config files.
- Document any data-flow changes in `README.md`.
- Update `README.md` when changing Supabase, session, token, or auth-like behaviour.
- Do not add new external services without documenting what they do, what data passes through them, and why they are needed.

## Pull requests

When opening a PR, it helps to include:

- What changed
- Why it changed
- Any screenshots or short recordings for UI changes
- Manual test notes
- Any limitations or follow-up TODOs

## Good first contributions

Examples:

- Improve documentation
- Tighten validation or error messages
- Polish presenter or participant UI
- Add sample session JSON
- Improve accessibility
- Fix small realtime edge cases

## Questions

If you are unsure about a direction, prefer the simpler option and explain the tradeoff in your PR notes.
