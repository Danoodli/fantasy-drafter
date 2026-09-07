<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Draft Cockpit — project notes

- **What this is**: a $0-cost, local-first fantasy football draft assistant. See README.md and handoff doc for full context.
- **Engine is pure**: everything in `lib/engine/` must stay I/O-free and deterministic (seeded RNG) — it's unit-tested and replayed in the backtest harness. `Date.now()`/`Math.random()` don't belong there.
- **Strategies are config, not code**: never write `if (strategy === 'zero-rb')` in the engine. Add strategies to `config/strategies.json`.
- **ETL fixtures are the offline fallback**: `data/raw/` is committed on purpose. `pnpm build:board` must always work offline via those fixtures, loudly warning about staleness.
- **No paid services at runtime**: no databases, no LLM calls at runtime, no API keys anywhere in the repo. If a change needs one, stop and flag it.
- **Data budget (2026-09-04)**: the owner will spend up to ~$20 and hand-export CSVs (especially historical datasets) to close a *measured* modeling hole — but only after the unified decision model ships and its backtest gates pass. Propose a dataset by naming the residual it would shrink; the owner sources it. Runtime stays $0.
- **Tests**: `pnpm test` before committing engine or ETL changes. The <50ms recompute test is a real requirement, not a suggestion.
- **Pick ingestion is pure + I/O split**: parsing/matching for paste import and screen sync lives in `lib/draft/pasteImport.ts` and `lib/draft/ocrMatch.ts` (unit-tested, no browser APIs); clipboard, display capture and the Tesseract worker live in `lib/client/screenCapture.ts` and components. Every ingestion path ends in `useDraft.applyImport` so undo, history and the engine see one kind of pick.
- **Tesseract.js** is the only runtime dependency that loads assets from a CDN (its worker, WASM core and English data, free, browser-only, lazily imported when Screen sync starts). It never runs on a server.
- **Engine levers live in `config/`** with an off state that reproduces the previous behavior exactly (e.g. `config/survival.json`: `tailScale 1`, `wideShare 0`). Add a new lever the same way; never bury one in a constant.
- **CI lanes**: `pnpm build:board --lane=fast` must never call FantasyPros or the Sleeper player dump; add a source to the fast lane only if it tolerates 48 fetches a day. The browser refetches the board with `cache: "no-cache"` at Setup and draft start; `public/sw.js` is network-first for `/data/*`. Live signals (trending, ESPN news, RSS, the Bluesky wire and lists, ESPN's injuries table, Jetstream) all flow through `lib/client/useLiveSignals.ts`; grade them onto the board only via the pure `gradeBoard` in `lib/engine/injuryFeed.ts`.
- **Newsroom** (`components/Newsroom.tsx`) is a pure consumer: `useLiveSignals` → `gradeBoard` → `buildFeed` (`lib/engine/newsImportance.ts`). Add a news source in the hook, a severity bucket in the engine, never in the component.
