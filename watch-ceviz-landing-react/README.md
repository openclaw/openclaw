# Watch Ceviz Landing React Scaffold

A component-oriented React/TSX version of the Watch Ceviz landing page work.

## Structure

- `src/LandingPage.tsx` — page composition
- `src/content/landingContent.ts` — copy + structured content
- `src/components/` — reusable UI sections
- `src/landing.css` — base styles for the page
- `src/main.tsx` — Vite entry point
- `index.html` — app shell
- `vite.config.ts` — Vite config
- `package.json` — scripts and dependencies

## Goal

Move from static mockup to a runnable frontend scaffold.

## Notes

- audience: founder-operator
- public pricing: Personal only
- public billing: monthly only
- tone: technical, focused, non-hype

## Run locally

```bash
cd watch-ceviz-landing-react
npm install
npm run dev
```

## Current state

This is now a minimal Vite + React + TypeScript app scaffold, ready to preview and then migrate into a production frontend repo later.

## Natural next step

Refine visuals, then either:

1. keep building inside this Vite app
2. port into a real marketing/frontend repo
3. adapt into Next.js if SSR or app-level routing becomes important
