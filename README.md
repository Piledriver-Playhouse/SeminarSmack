<div align="center">
  <img src="https://github.com/bitboyb/SeminarSmack/blob/main/public/assets/img/logo.png?raw=true" alt="SeminarSmack Logo" width="120" style="border-radius: 20%; margin-bottom: 20px;" />
  <h1>SeminarSmack</h1>
  <p><strong>A free, open-source classroom interaction tool.</strong></p>

  <a href="https://bitboyb.github.io/SeminarSmack/">
    <img src="https://img.shields.io/badge/Live_Demo-Try_it_now!-ee9ad5?style=for-the-badge" alt="Live Demo" />
  </a>
  <a href="https://github.com/sponsors/bitboyb">
    <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub" />
  </a>
  <a href="https://bitboyb.github.io/SeminarSmack/api/">
    <img src="https://img.shields.io/badge/API_Docs-View_Reference-5fd9d7?style=for-the-badge" alt="API Docs" />
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-gray?style=for-the-badge" alt="License MIT" />
  </a>

  <p>Create live polls, quizzes, short text questions, ratings, and kanban boards. Students join with a QR code or typed room code from any device.<br/>No login required. No install. Free to use.</p>

  <br />
  <img src="https://github.com/bitboyb/SeminarSmack/raw/main/public/assets/img/seminar-smack-preview.gif" alt="SeminarSmack preview" width="80%" style="border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2);" />
</div>

---

## Quick Start

1. Open the [live SeminarSmack app](https://bitboyb.github.io/SeminarSmack/).
2. Click **Create a session** and add your questions.
3. Click **Start session**. A room code and QR code are generated automatically.
4. Share the QR code, join link, or room code with students.
5. Present live, step through activities, see responses update, and export responses when finished.

## What It Does

- Live polls with realtime results.
- Quizzes with an optional correct answer reveal.
- Short text responses.
- Ratings with optional comments.
- Simple kanban boards with presenter-defined columns.
- Anonymous questions from participants.
- QR code and room-code joining.
- Client-side session import/export and response export.

## How It Works

- Sessions created in the browser are stored in the educator browser's `localStorage`.
- The presenter page is the source of truth during a live session.
- Live updates are sent through Supabase Realtime Broadcast when Supabase is configured.
- The app does not run a custom backend server, but it does depend on Supabase's third-party realtime infrastructure for live multi-device sessions.
- The QR code is generated locally in the browser using a vendored copy of [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator).
- SeminarSmack does not require student accounts or a custom database table. Supabase Realtime still processes realtime messages while a session is live.

## Data Flow

Users enter session titles, prompts, answer options, ratings, short text, kanban cards, optional URLs, and anonymous questions. Students are not required by the app to identify themselves, but educators should avoid prompts that ask for unnecessary personal data.

During a live session, presenter state and participant submissions are broadcast over a Supabase Realtime channel for the room code. The presenter browser collects the live state and can export responses as a JSON file. Session drafts and lightweight per-device submission limits are stored in browser `localStorage`.

By default, SeminarSmack is designed for temporary classroom interaction rather than long-term records. Exported JSON files are controlled by whoever downloads and stores them. Before using the tool with students, educators or institutions should check local policy, approved services, data-retention expectations, and whether the configured Supabase project is appropriate for student-facing activity.

## Clean Setup

```bash
git clone https://github.com/bitboyb/SeminarSmack.git
cd SeminarSmack
npm install
cp public/js/config.template.js public/js/config.js
```

Edit `public/js/config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "your-publishable-anon-key"
};
```

Run locally with any static server:

```bash
npx serve public
```

Build generated API docs:

```bash
npm run build
```

Run checks:

```bash
npm run lint
npm test
```

## What You Need Before Deploying

- A Supabase project URL.
- A Supabase publishable anon key.
- Supabase Realtime enabled for the project.

Never use a Supabase `service_role` key in this browser app.

## GitHub Pages Deployment

This repository includes `.github/workflows/pages.yml`. The workflow:

1. checks out the repository;
2. validates `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`;
3. generates `public/js/config.js` during deployment;
4. runs `npm ci`;
5. runs `npm run docs`;
6. uploads `public/` to GitHub Pages.

Required repository settings:

- Settings -> Pages -> Source -> **GitHub Actions**.
- Add repository variables or secrets named `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
- Push to `main` or run the workflow manually.

Common failure points:

- Pages is still set to deploy from a branch instead of GitHub Actions.
- Supabase variables or secrets are missing.
- A `service_role` key was used instead of the publishable anon key.
- Supabase Realtime is unavailable or blocked by the local network.
- `public/js/config.js` was expected to be committed; it is generated in deployment and ignored for local use.

## Example Activity JSON

### Rating

```json
{
  "id": "rate-session-feedback",
  "type": "rate",
  "title": "How useful was this session?",
  "prompt": "Rate the session and optionally leave a comment.",
  "maxRating": 5,
  "comment": true
}
```

### Kanban

```json
{
  "id": "project-kanban",
  "type": "kanban",
  "title": "Project Ideas Board",
  "prompt": "Add an idea, reference image, video, GIF, or useful link.",
  "columns": [
    { "id": "ideas", "title": "Ideas" },
    { "id": "in-progress", "title": "In Progress" },
    { "id": "done", "title": "Done" }
  ]
}
```

## Repository Layout

```text
/public
  index.html             Landing page
  create.html            Session builder
  join.html              Student join page
  present.html           Presenter controls
  API.md                 API documentation homepage
  assets/
    css/styles.css       Design system
    img/logo.png         Logo
  js/
    app.js               Shared utilities, validation, state helpers, router
    supabase.js          Supabase Realtime wrapper
    config.template.js   Local config template
    pages/
      landing.js
      session-builder.js
      presenter.js
      participant.js
    vendor/
      qrcode.min.js      QR code generator
  sessions/
    sample-session.json
    example-session.json

/.github/workflows/pages.yml
CONTRIBUTION.md
README.md
LICENSE
```

## URL Reference

Recommended flow:

```text
create.html                       Build a session
present.html?room=spark-4821      Host the session
join.html?room=spark-4821         Student join
```

Legacy presenter links with `host=<token>` are still accepted. The presenter page imports the token into `localStorage` and removes it from the visible URL.

## Security Notes

- Uses the Supabase publishable anon key only, which is expected to be visible in browser code.
- Never use a `service_role` key.
- The host token is a lightweight browser-side control guard, not a full authentication system.
- If a student obtains the host token, they may be able to affect presenter-controlled session state.
- Room codes and local submission limits are suitable for informal classroom use, not high-stakes assessment.

## Ethos

SeminarSmack is built on the belief that simple educational tools should be accessible to everyone. It is intentionally small, static, low-cost to run, and open to adaptation.

The goal is simple: make it easier for educators to create active, engaging lessons without adding another cost, account, or platform dependency.

## License

MIT
