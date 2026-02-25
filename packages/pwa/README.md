# VSC Codex Bridge PWA

ChatGPT-style app shell for hub API workflows (top bar + left drawer + infinite chat timeline).

## Current capabilities

- Collapsible left drawer (menu button) for connection and workspace navigation.
- Hub URL is auto-derived from the current app origin (no manual host/port input).
- Nested workspace -> threads tree in the drawer.
- Stable selected thread across refreshes/reloads.
- Infinite-scroll chat timeline with streaming assistant updates.
- Composer with dynamic action:
  - `Send` mode (idle),
  - `Steer` mode (while agent is running).
- Real-time “thinking” indicators in top bar and chat body.
- Voice dictation support via browser SpeechRecognition API (when available).
- Rich assistant rendering:
  - markdown,
  - code blocks,
  - links,
  - plan snippets,
  - diff blocks with add/remove/meta coloring and file tags.
- Pending approvals inline in chat panel.
- WebSocket stream event log (drawer panel) + polling fallback.
- Fully responsive layout for desktop and mobile.

## Build static assets

```bash
cd packages/pwa
npm run build
```

This writes static files to `packages/pwa/dist`.
The hub serves that folder by default.
