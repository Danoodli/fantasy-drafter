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
- **No paid services**: no databases, no LLM calls at runtime, no API keys anywhere in the repo. If a change needs one, stop and flag it.
- **Tests**: `pnpm test` before committing engine or ETL changes. The <50ms recompute test is a real requirement, not a suggestion.
