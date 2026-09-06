# Cockpit UX + pick ingestion + survival calibration — implementation plan

> **For agentic workers:** executed inline in one session, one branch (`cockpit-ux-and-ingestion`), one commit per feature so any feature can be reverted alone. No approval stops (owner's directive).

**Goal:** make the cockpit usable on any draft site — explicit navigation with custom confirms, a recent-picks feed and resync tools for manual mode, and three ways to get the room's picks in without typing each name: paste import, an on-the-clock shortlist, and screen-capture OCR. Plus a measured, switchable survival-tail calibration in the engine.

**Architecture:** all ingestion paths end in the existing `useDraft.markDrafted` / `markMany` so undo, toasts, history and the engine see one kind of pick. Parsing and matching are pure modules under `lib/draft/` (unit-tested); browser APIs (clipboard, display capture, Tesseract worker) live in `lib/client/` and components. The engine stays pure; the only engine change is a config-driven tail parameter for the survival model and the Monte Carlo market noise, plus exposing the full ranked shortlist in `EngineOutput.scored`.

**Tech stack:** Next.js 16 / React 19 / Tailwind 4 (existing), vitest (existing), `tesseract.js` (new, browser-only, lazy-loaded, WASM + language data from its default CDN).

**Spec:** the assessment in this session's chat (2026-09-05), approved by the owner with the ordering: UI → paste import → shortlist → OCR → engine.

## Global constraints

- `lib/engine/` stays I/O-free and deterministic; `<50 ms` recompute test must pass.
- No paid services, no API keys, no server on the hot path. Tesseract runs in the browser.
- Strategies are config; no strategy branching in the engine.
- Every new engine behavior has a one-variable off switch in `config/`.

## File map

| File | Responsibility |
|---|---|
| `components/ConfirmDialog.tsx` (new) | Custom modal: title, body, confirm/cancel labels, danger flag, Esc/Enter. Replaces every `window.confirm`. |
| `app/page.tsx` | Screen state (`setup` \| `cockpit`) separate from config so Home keeps the draft; passes `resume` to Setup. |
| `components/Setup.tsx` | Resume card at the top when a draft is in progress; "New draft" clears state. |
| `components/Cockpit.tsx` | Home button, confirm dialogs, recent picks strip, room strip, shortlist, paste handler, screen-sync entry, header hierarchy. |
| `components/RecentPicks.tsx` (new) | Last N picks with slot, position, name; correct/undo per row. |
| `components/RoomStrip.tsx` (new) | One row of slots with position counts; on-clock + mine highlighted; click for roster. |
| `lib/client/useDraft.ts` | `markUnknown()`, `setCurrentPick(n)`, `undoMany(n)`, `fillUnknown(pickNo, player)`. |
| `lib/draft/pasteImport.ts` (new, pure) | `parsePastedPicks(text, players, draftedIds)` → matched / unmatched / pick numbers; order detection. |
| `components/PasteImport.tsx` (new) | Preview modal: matched rows (toggle), unmatched with suggestions, order flip, commit. |
| `components/Shortlist.tsx` (new) | Engine's ranked list for the slot on the clock; one-click mark; running hit rate. |
| `lib/engine/recommend.ts` | `scored` (full ranked candidate list) on the lineup/blend path too. |
| `lib/draft/ocrMatch.ts` (new, pure) | Closed-vocabulary matching of noisy OCR lines to board players; pick-number extraction; frame agreement. |
| `lib/client/screenCapture.ts` (new) | `getDisplayMedia` → video → cropped, upscaled canvas frames on an interval; Tesseract worker lifecycle. |
| `components/ScreenSync.tsx` (new) | Share → preview → drag region → watch; status, pause, newest-first toggle. |
| `config/survival.json` (new) | `{ "tailScale": 1, "df": 0 }` — df 0 = normal (off). |
| `lib/engine/survival.ts` | Student-t tail when `df > 0`; `tailScale` widens stdev. |
| `lib/engine/montecarlo.ts`, `completion.ts` | Market noise uses the same tail model so the sim and the survival math agree. |
| `scripts/calibrate-survival.ts` (new) | Pull real Sleeper drafts (draft ids or a league id chain), score predicted vs realized availability, report reliability + Brier by tail setting, print the recommended config. |
| `tests/pasteImport.test.ts`, `tests/ocrMatch.test.ts`, `tests/survival.test.ts` (new) | Pure-module tests. |
| `README.md` | Document every new user-facing feature and the survival lever. |

## Tasks and commit boundaries

All nine tasks landed on `cockpit-ux-and-ingestion` on 2026-09-05 (commits 83c5cad … edd63d9 plus docs). Deviations from the plan: the survival tail is a normal/wide mixture (`tailScale`, `wideShare`, `wideFactor`) instead of a Student-t — closed form with the existing CDF and trivially the same sampler in the sim; it ships OFF because FFC's own extremes are consistent with a normal and no real-draft ids were available in the repo to fit against. `pnpm calibrate:survival` is the fitting tool.

1. **Navigation + confirm dialog + resume.** ConfirmDialog; Home button; page keeps config on Home; Setup resume card; three native confirms replaced. Commit: `UI: Home button, custom confirm dialog, resume an in-progress draft from setup`.
2. **Manual-mode sync tools.** `markUnknown`, `setCurrentPick`, RecentPicks strip. Commit: `UI: recent picks feed, unknown-pick placeholder, set-current-pick resync`.
3. **Room strip.** Commit: `UI: room strip — every slot's build, on-clock slot highlighted`.
4. **Header hierarchy.** Strategy picker and tour into the ⋯ menu; walkthrough step retargeted. Commit: `UI: header hierarchy — Home and Undo prominent, strategy demoted to the menu`.
5. **Paste import.** Pure parser + tests first, then the modal and the global paste handler; batch undo. Commit: `Paste import: mark a whole picks panel in one paste`.
6. **Shortlist.** Engine `scored` (tests still pass) → commit `Engine: expose the full ranked shortlist in EngineOutput.scored`. Then Shortlist component + hit-rate → commit `UI: on-the-clock shortlist for the team picking now`.
7. **Screen sync.** `pnpm add tesseract.js`; pure matcher + tests; capture module; component; cockpit wiring. Commit: `Screen sync: OCR the draft room's picks panel and mark picks automatically`.
8. **Survival tail calibration.** Config + engine lever + tests; calibration script; run it if real draft data is reachable, set config from the measurement, else leave off and document. Commit engine and script separately.
9. **Docs + memory.** README sections; AGENTS.md note on Tesseract; memory update.
