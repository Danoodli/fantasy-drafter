# Leg D — Design overhaul: a look that is ours, in light and dark

Date: 2026-09-09. Status: drafted from the owner's brief while they were away;
assumptions are stated where the brief left an axis free. Fourth spec.
**Runs after Leg B and before Leg A's gates (17–18) and Leg C**, by the
owner's ordering: visible change first.

## The brief, verbatim intent

The owner, looking at `/season` after Task 13: "the ui is pretty god awful …
there's no back button, there's no color at all, it's not clear what's
clickable, player names when clicked don't open a player card … make the
whole site and especially the season tab look a lot better, be more colorful,
and above all else try to NOT follow the 'made by ai' classic look that the
rest of the site honestly has right now … ideally we'd have light mode,
different color themes, etc."

Three of those items (back link, clickable names → player card, position
colour on tags) shipped inside Leg B Task 13. This spec is the rest: the look.

## What "the AI look" is, so we can avoid it on purpose

From the design-industry writing of 2025–26 (925 Studios' "AI slop" guide,
Alan West's "How to fix the AI-generated look", prg.sh's "Why your AI keeps
building the same purple gradient website", Figma's and Envato's 2026 trend
reports) the recognisable tells are:

1. **Everything is a card.** Uniform rounded rectangles with a 1 px border on
   a slightly lighter grey, stacked vertically, same padding, same radius.
2. **Grey on grey.** A near-black field, `neutral-800` panels, `neutral-400`
   text, one accent used timidly. No hierarchy beyond font size.
3. **Default type.** Inter/system sans everywhere, one weight, no display
   face doing real work; or the opposite default — cream background, serif
   display, terracotta accent.
4. **Decoration standing in for structure.** Numbered markers, hairline
   dividers and gradient blobs that encode nothing about the content.
5. **Nothing looks clickable.** Text buttons with no fill, no hover state,
   no focus ring; links styled like body text.
6. **Placeholder voice.** "Coming soon", "Loading…", "No data available".

Today's app hits 1, 2, 4 (partially) and 5 squarely. It escapes 3: the
Barlow / Barlow Condensed / IBM Plex Mono stack is a real broadcast-sports
choice and stays. It also already owns one genuinely good idea — **the
position palette IS the information** (QB red, RB teal, WR blue, TE orange,
K violet, DST slate). The overhaul builds outward from that idea instead of
importing a new one.

## Direction: the draft board and the broadcast

The two artifacts every fantasy player recognises are the **physical draft
board** — a wall of coloured sticker cards, one colour per position, laid in
snake rows — and the **TV score bug / lower third**: a condensed headline on
a solid slab, a big number, a small label. Both are colourful, both encode
information with colour and weight, neither is a grey card. That is the
vernacular.

- **Signature element (the one risk): the sticker edge.** Every player row,
  chip and card carries a solid 4 px left edge in the player's position
  colour — the sticker on the board — and the surface behind it is tinted
  4–6 % toward that colour. A lineup becomes a strip of stickers; a waiver
  list reads at a glance as "three RBs, a TE". It replaces the 1 px grey
  border as the way things are bounded.
- **Section headers as lower-thirds.** A section is introduced by a
  condensed-display headline on a slab in the theme's accent, with the
  section's one number (win probability, playoff odds, projected total) set
  large beside it and its label small. Headline, number, label: that is the
  broadcast grammar, and it gives the page the hierarchy it lacks.
- **Numbers carry meaning through colour, once.** Win probability and
  playoff odds are the only values that get semantic colour (above 60 %
  accent-good, below 40 % accent-bad, else ink). Everything else stays ink.
  Spending colour in one place is what keeps it legible.
- **Structure encodes truth.** No numbered markers; the only ordered list on
  the site is the draft order, which is genuinely a sequence. Dividers are
  the sticker edges and the slab headers, nothing else.

## Themes and light mode

A theme is a set of CSS variables on `<html data-theme="…">`. Tailwind v4's
`@theme` tokens (`--color-field`, `--color-panel`, `--color-panel-2`,
`--color-line`, `--color-ink`, `--color-ink-dim`, `--color-ink-faint`,
`--color-accent`, `--color-accent-ink`, `--color-good`, `--color-bad`,
`--color-warn`, `--color-live`, and the six position colours) resolve to
per-theme variables, so every existing `bg-panel`/`text-ink-dim` class keeps
working and only the values move. Four themes ship; each is a complete palette
that passes WCAG AA for body text and 3:1 for the position colours on their
tinted surfaces:

| Theme | Mood | Field | Panel | Ink | Accent |
|---|---|---|---|---|---|
| **Night game** (default dark) | today's cockpit, deepened | `#0E1319` | `#171E27` | `#EEF2F5` | turf `#3CC9A7` |
| **Day game** (default light) | chalk and turf under sun; cool white, not cream | `#F4F7F5` | `#FFFFFF` | `#14202B` | turf `#167A5F` |
| **Prime time** (dark) | navy and gold broadcast | `#0B1220` | `#131C2E` | `#F3EEDF` | gold `#E8B33F` |
| **Throwback** (light) | 90s paper board: warm grey field, primary stickers | `#EFEDE6` | `#FFFDF7` | `#1B1B1B` | red `#C4381F` |

Every value in every theme was run through a relative-luminance check while
writing the plan (2026-09-09): ink and ink-dim ≥ 4.5:1 and ink-faint ≥ 3:1 on
field, panel and panel-2; each position colour ≥ 3:1 on its 6 %-tinted panel;
accent-ink ≥ 4.5:1 on accent; good/bad/warn ≥ 3:1 on panel. The full palettes
are in the plan and pinned by `tests/theme.test.ts`.

Position colours are re-tuned per theme (the dark values above are too pale
on white), but a position keeps its hue across themes so a user's memory of
"RB is teal" survives a theme switch.

- Default follows `prefers-color-scheme`; the choice persists in
  `localStorage` (`draft-cockpit-theme-v1`), modelled on `lib/client/config.ts`.
- The theme is applied before first paint by an inline script in
  `app/layout.tsx` reading localStorage, so light-mode users never see a
  dark flash.
- The switcher lives in the shared app bar (below), as a segmented control
  of four swatches, keyboard-navigable, with names.
- *Amended while planning:* the app bar carries navigation and the theme
  switcher only. The live-signals dot stays inside the routes that already
  poll live signals (Newsroom, `/season`), because the bar has no board to
  poll against and loading one just for a dot would double the requests.
- `prefers-reduced-motion` disables the existing spring transitions and the
  entrance animations globally.

## The shared shell

Every route (`/`, `/season`, `/newsroom`, `/mock-board`) renders inside one
app bar: brand mark at left, route tabs (Draft · In-season · Newsroom), the
live-signals dot with its last-refresh time, the theme switcher at right. That
is the back button the owner asked for, generalised — no page is a dead end —
and it is where the app gets one consistent voice. On phones the tabs collapse
to icons with labels beneath.

## Affordances: what is clickable looks clickable

- **Buttons** are filled (accent on accent-ink) or outlined (2 px in ink-dim)
  — never bare text. Hover lifts brightness 10 %, active scales 0.97 (the
  existing spring), disabled drops to 40 % and loses the hover.
- **Links** are ink with a 2 px accent underline that appears on hover.
- **Rows that open something** (player names, roster picks, news items) show
  a hover tint of the row's position colour and a trailing chevron on hover;
  the name itself is set in the display face at 500 weight so it reads as a
  target.
- **Focus** is the existing global `:focus-visible` ring, re-coloured to the
  theme accent.
- **Chips** (roster players, tags) are stickers: edge, tint, name, `×`.

## Copy

Sentence case, plain verbs, no filler. "Add a player" not "Add a player by
name…"; "No projection yet" not "—" in the player card (the table keeps "—"
because a column needs a glyph). Empty states say what to do next: "Your
roster is empty. Sync a Sleeper league or add players by name." Errors say
what happened and how to fix it, in the app's voice.

## Route by route

- **`/season`** (first): lower-third headers for Lineup, Matchup, Waivers,
  Playoff odds, Trade; the lineup table as a sticker strip with the changed
  rows carrying a small accent arrow; the win probability as the page's big
  number; waiver rows as stickers with the reason as the second line; the
  playoff table with the user's row filled in accent tint; the trade panel's
  three axes as three small lower-thirds (points / odds / cover).
- **`/` draft cockpit**: the recommendation is already the hero; give it the
  lower-third treatment (headline = player, big number = projected points or
  VONA, label = reason line) and sticker the tier board's cards; Setup gets
  the app bar and filled buttons.
- **`/newsroom`**: sticker edges on items by the player's position; the
  severity buckets become slab headers.
- **Player card** (`PlayerModal`): sticker edge in the player's colour down
  the left; the in-season `WeekLine` from Leg B as the card's lower-third.
- **`/mock-board`**: untouched visually except tokens (it is a fixture for
  OCR; changing its cell markup would break `pnpm ocr:check`).

## Out of scope

New features, engine changes, mobile-native gestures, custom illustration.
Fonts stay the current three (a fourth family would be the "default" move the
brief warns against; the change is in how they are used).

## Testing and gates

- `pnpm ocr:check` must still pass (the mock board's OCR fixture).
- A Playwright script (`scripts/ui-shots.ts`, `pnpm ui:shots`) renders `/`,
  `/season` (manual roster and Sleeper-synced), `/newsroom` and the player
  card in all four themes to `docs/design/shots/*.png` — the review artifact
  for the owner, committed so a before/after exists.
- Contrast check: a unit test over the four theme palettes asserts AA for
  ink on field/panel and 3:1 for each position colour on its tinted surface,
  using a pure relative-luminance function in `lib/client/theme.ts`.
- `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm lint` clean; the draft
  recompute budget untouched (this leg does not touch `lib/engine`).
