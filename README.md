# Social Studies Flashcards

## Quick Reference
### Data Folder
- `data/socialstudies.json` is the default deck served to the browser; update or replace it to change the prompt set.
- `data/card-state.json` stores live spaced-repetition progress and can be deleted (while the server is stopped) to reset the scheduler.
- `data/vocab.json` plus `data/card-state-vocab.json` hold an alternate vocabulary deck/state if you want to swap content sources.

### Server Modes
- `npm start` launches the production-like Express server with the current assets.
- `npm run dev` starts the Nodemon/parcel combo in watch mode for hot reloads across the API and front-end.

## Four-Year Check-In
- **Standard run:** `npm start` boots the Express server in the current shell; point your browser at http://localhost:3000 once it prints "Server listening".
- **Hot-reload/dev mode:** `npm run dev` keeps both the server and front-end in watch mode so changes auto-reload; cancel with `Ctrl+C`.
- **Data source:** both modes read the same deck at `data/socialstudies.json`, so update that file (or drop in a replacement) before launching if you want fresh content.

Local-first flashcard web app tailored to the provided social studies questions. Every time you score yourself, the server persists the schedule so you can stop and resume later without losing place.

## Features
- Express server that serves the UI and JSON endpoints (`/api/cards/next`, `/api/cards/:id/rate`).
- Smart scheduling rules that interpret **Trivial**, **Easy**, **Normal**, and **Hard** into increasingly spaced review intervals (or retire the card altogether).
- Front-end card experience with flip animation, progress counters, and live feedback.
- Persistent progress stored in `data/card-state.json` so that restarting the app resumes the queue exactly where you left it.

## Prerequisites
- [Node.js](https://nodejs.org/) **18.x or newer** (includes `npm`).
- The provided `data/socialstudies.json` deck (already copied into the repo).

## Setup
1. Install dependencies (run inside this folder):
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Visit [http://localhost:3000](http://localhost:3000) in your browser.

During development you can use the hot-reload script:
```bash
npm run dev
```

## Data & Persistence
- The master deck lives in `data/socialstudies.json`.
- Runtime progress is stored in `data/card-state.json`. It is already ignored by git so you can freely reset progress by deleting that file while the server is stopped.

## API Quick Reference
| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/cards/next` | Returns the next due card plus deck statistics. |
| `POST` | `/api/cards/:id/rate` | Saves a rating (`trivial`, `easy`, `normal`, `hard`) and returns the updated queue. |
| `GET` | `/api/health` | Lightweight status check. |

Each response includes `meta` counts so the UI can keep its counters in sync.

## Troubleshooting
- If `npm` is not available on your system, install Node.js 18+ and retry `npm install`.
- If you want to start over, delete `data/card-state.json` (with the server stopped) and the scheduler will rebuild fresh on next launch.
