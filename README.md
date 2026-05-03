# SeminarSmack

A free, open-source classroom interaction tool. Create live polls, quizzes, and short text questions — students join with a QR code from any device.

## Quick start (public use)

1. **Open the site** — visit the deployed SeminarSmack page.
2. **Create a session** — click "Create a session", add your questions.
3. **Start hosting** — click "Start session". A room code and QR code are generated automatically.
4. **Share with students** — show the QR code on screen or share the join link.
5. **Present live** — step through activities, see answers update in realtime, reveal correct answers when ready.

No login required. No install. Free to use.

## What it does

- **Live polls** — multiple-choice questions with realtime results
- **Quizzes** — mark a correct answer and reveal it when ready
- **Short text responses** — collect open-ended answers from students
- **QR code join** — students scan and answer from their phones
- **Session export/import** — save your session as JSON and reuse it later

## How it works

- Sessions created in the browser are stored in your browser's `localStorage`.
- The presenter page is the **source of truth** — it broadcasts state to all connected students via Supabase Realtime Broadcast.
- The **QR code** on the presenter page is generated locally in the browser using a vendored copy of [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). No QR API, CDN, or backend service is used.
- There is **no database** and **no backend server**. Everything runs in the browser.
- Sessions are temporary and local to the browser that created them, unless you export them as JSON.

## Self-hosting / development

### 1. Fork the repo

Fork this repository to your own GitHub account.

### 2. Create a Supabase project

Create a free Supabase project and collect:

- Project URL
- Publishable key (anon key)

Do **not** use a `service_role` key.

### 3. Add GitHub repository variables

In your fork, add these repository variables (or secrets):

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The GitHub Actions workflow generates `docs/config.js` during deployment.

### 4. Enable GitHub Pages

In your fork: Settings → Pages → Source → GitHub Actions.

### 5. Push to main

Push to `main` or trigger the workflow manually. The site deploys from `docs/`.

### Local preview

```bash
cp docs/config.template.js docs/config.js
```

Edit `docs/config.js` with your Supabase credentials, then serve `docs/` locally.

## Repository layout

```text
/docs
  index.html          — Landing page
  create.html         — Session builder
  join.html           — Student join page
  present.html        — Presenter controls
  styles.css          — Design system
  app.js              — Shared utilities + router
  session-builder.js  — Create page logic
  presenter.js        — Presenter logic
  participant.js      — Student join logic
  landing.js          — Landing page module
  supabase.js         — Supabase client
  config.template.js  — Config placeholder
  vendor/
    qrcode.min.js       — QR code generator (vendored, no CDN)
  sessions/
    sample-session.json
    example-session.json

/.github/workflows/pages.yml
README.md
LICENSE
```

## URL reference

### New flow (recommended)

```
create.html                                    — Build a session
present.html?room=SPARK-4821&host=<token>      — Host the session
join.html?room=SPARK-4821                      — Student join
```

### Legacy flow (still supported)

```
present.html?room=abc&session=sample-session&host=token
join.html?room=abc&session=sample-session
```

## Security notes

- Uses the Supabase **publishable key** only — visible in the browser, which is expected.
- Never use a `service_role` key.
- The host token is a lightweight browser-side control guard, **not** a full authentication system.
- This is a lightweight teaching tool, not a secure exam platform.

## License

MIT
