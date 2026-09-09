"use client";

// Screen sync: share the draft-room tab, drag a box around its pick history,
// and the cockpit reads the room off the screen continuously. Works for any
// site — ESPN, Yahoo, Underdog, DraftKings, a league-mate's screen share —
// because it never talks to the site at all.
//
// What it trusts is ORDER. Each read is the panel's names top to bottom (a
// toggle flips panels that list newest first); that ordered list is
// reconciled with the picks we already know (lib/draft/sequence.ts): new
// names append in order, a pick we missed is inserted where it belongs, and
// MY picks are recorded like everyone else's — I draft on the site, the app
// just watches (back-to-back picks included). Two consecutive reads must
// agree before a name counts. Pick numbers in front of a LIST entry are never
// read: OCR junk in front of a name is not a pick number.
//
// A draft BOARD (DraftKings, Yahoo) is a grid, not a list: one cell per pick,
// rounds snaking left and right, so order says nothing. But every cell wears
// its own "round.pick" label, and those ARE trusted: once a frame shows two
// such labels the grid reader (lib/draft/ocrGrid.ts) takes over and each
// cell's name goes through the numbered import path with its pick number.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPlayer } from "../lib/types";
import type { ImportItem, ImportOutcome, SequenceOutcome } from "../lib/client/useDraft";
import { FrameAgreement, matchOcrLines, type OcrLine } from "../lib/draft/ocrMatch";
import { readGrid } from "../lib/draft/ocrGrid";
import {
  FULL_FRAME,
  OCR_WORKERS,
  captureSupported,
  getOcrScheduler,
  grabFrame,
  loadRegion,
  recognizeFrame,
  saveRegion,
  startCapture,
  stopCapture,
  type Region,
} from "../lib/client/screenCapture";

interface Props {
  players: BoardPlayer[];
  draftedIds: Set<string>;
  /** League size: a board grid's "round.pick" labels need it for the overall pick number. */
  teams: number;
  /** Players already on the board, by pick number: lets a grid cell's "B. Robinson" tie resolve to whoever is NOT already placed elsewhere. */
  placed: Map<string, number>;
  /** Apply one ordered read of a pick LIST. Returns what was placed. */
  onFrame: (playerIds: string[]) => SequenceOutcome | void;
  /** Apply one read of a board GRID: every cell carries its pick number. Returns what changed. */
  onGrid: (items: ImportItem[]) => ImportOutcome | void;
  onClose: () => void;
}

type Phase = "idle" | "sharing" | "watching" | "paused";

/** Minimum gap between read starts; with OCR_WORKERS in flight the room is sampled several times a second. */
const READ_GAP_MS = 350;
const PREVIEW_W = 520;
const NEWEST_FIRST_KEY = "draft-cockpit-screen-newest-first-v1";

function loadNewestFirst(): boolean {
  try {
    return localStorage.getItem(NEWEST_FIRST_KEY) === "1";
  } catch {
    return false;
  }
}

export default function ScreenSync({ players, draftedIds, teams, placed, onFrame, onGrid, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const agreementRef = useRef<FrameAgreement | null>(null);
  const inFlightRef = useRef(0);
  const frameSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [region, setRegion] = useState<Region>(() => loadRegion() ?? FULL_FRAME);
  const [newestFirst, setNewestFirstState] = useState<boolean>(loadNewestFirst);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [lastLines, setLastLines] = useState<OcrLine[]>([]);
  const [mode, setMode] = useState<"list" | "grid" | null>(null);
  /** The last frame OCR'd (enhanced canvas) and everything read from it — for the debug report. */
  const lastFrameRef = useRef<HTMLCanvasElement | null>(null);
  const lastReadRef = useRef<Record<string, unknown> | null>(null);
  const [copiedReport, setCopiedReport] = useState(false);
  const [lastNames, setLastNames] = useState<string[]>([]);
  const [reads, setReads] = useState(0);
  const [marked, setMarked] = useState(0);
  const [lastPlaced, setLastPlaced] = useState<string[]>([]);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [showLarge, setShowLarge] = useState(true);

  const setNewestFirst = (v: boolean) => {
    setNewestFirstState(v);
    try {
      localStorage.setItem(NEWEST_FIRST_KEY, v ? "1" : "0");
    } catch {
      // fine
    }
  };

  // Latest props for the async loop without re-subscribing every render.
  const latest = useRef({ players, draftedIds, region, newestFirst, teams, placed, onFrame, onGrid });
  useEffect(() => {
    latest.current = { players, draftedIds, region, newestFirst, teams, placed, onFrame, onGrid };
  }, [players, draftedIds, region, newestFirst, teams, placed, onFrame, onGrid]);

  const stopAll = useCallback(() => {
    stopCapture(streamRef.current, videoRef.current);
    streamRef.current = null;
    setPhase("idle");
  }, []);

  useEffect(() => () => stopCapture(streamRef.current, videoRef.current), []);

  async function share() {
    setError(null);
    if (!captureSupported()) {
      setError("This browser can't share a screen. Chrome, Edge or Safari 17+ on desktop can.");
      return;
    }
    try {
      const video = videoRef.current!;
      const stream = await startCapture(video);
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        // The user hit the browser's own "Stop sharing".
        stopAll();
        setStatus("Sharing ended.");
      });
      agreementRef.current = new FrameAgreement(latest.current.draftedIds);
      setPhase("sharing");
      setShowLarge(true);
      setStatus("Drag a box around the pick history or the draft board grid, then Watch.");
      // Warm the OCR engine while the user picks the region.
      getOcrScheduler((s, p) => setStatus(`Loading OCR engine… ${s} ${Math.round(p * 100)}%`)).then(
        () => setStatus((cur) => (cur.startsWith("Loading OCR") ? "OCR engine ready. Drag a box around the pick history, then Watch." : cur)),
        (err) => setError(`OCR engine failed to load: ${(err as Error).message}`)
      );
    } catch (err) {
      setError(`Couldn't start sharing: ${(err as Error).message}`);
    }
  }

  // Preview painter: draws the current frame (or region) into the preview canvas.
  useEffect(() => {
    if (phase === "idle") return;
    let raf = 0;
    const paint = () => {
      const video = videoRef.current;
      const canvas = previewRef.current;
      if (video && canvas && video.videoWidth) {
        const scale = PREVIEW_W / video.videoWidth;
        canvas.width = PREVIEW_W;
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const r = drag
            ? {
                x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1),
                w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0),
              }
            : { x: region.x * canvas.width, y: region.y * canvas.height, w: region.w * canvas.width, h: region.h * canvas.height };
          ctx.fillStyle = "rgba(16,21,27,0.55)";
          ctx.fillRect(0, 0, canvas.width, r.y);
          ctx.fillRect(0, r.y + r.h, canvas.width, canvas.height - r.y - r.h);
          ctx.fillRect(0, r.y, r.x, r.h);
          ctx.fillRect(r.x + r.w, r.y, canvas.width - r.x - r.w, r.h);
          ctx.strokeStyle = "#3cc9a7";
          ctx.lineWidth = 2;
          ctx.strokeRect(r.x, r.y, r.w, r.h);
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [phase, region, drag]);

  // The read loop: keep OCR_WORKERS reads in flight, start a new one every
  // READ_GAP_MS. Results are applied in capture order; a read that finishes
  // after a newer one has been applied is dropped.
  useEffect(() => {
    if (phase !== "watching") return;
    let cancelled = false;
    const read = async () => {
      if (cancelled || inFlightRef.current >= OCR_WORKERS) return;
      const video = videoRef.current;
      if (!video) return;
      const { players, draftedIds, region, newestFirst, teams, placed, onFrame, onGrid } = latest.current;
      const frame = grabFrame(video, region);
      if (!frame) return;
      const seq = ++frameSeqRef.current;
      inFlightRef.current++;
      try {
        const scheduler = await getOcrScheduler();
        const { lines, words } = await recognizeFrame(scheduler, frame);
        if (cancelled || seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        const agreement = agreementRef.current!;
        const stamp = new Date().toLocaleTimeString();
        setReads((n) => n + 1);
        setLastLines(lines);
        // A board GRID: cells labelled "round.pick". Two labels in the frame
        // and the grid reader takes over — the labels are the pick numbers,
        // so snake direction and panel order never matter.
        const grid = readGrid(words, players, { teams, placed });
        lastFrameRef.current = frame;
        lastReadRef.current = {
          when: new Date().toISOString(),
          region,
          frame: { width: frame.width, height: frame.height, video: { width: video.videoWidth, height: video.videoHeight } },
          teams,
          mode: grid.anchors >= 2 ? "grid" : "list",
          grid: { anchors: grid.anchors, picks: grid.picks.map((p) => ({ pickNo: p.pickNo, round: p.round, pick: p.pick, name: p.player.name, score: p.score, text: p.text })) },
          lines: lines.map((l) => l.text),
          words,
        };
        if (grid.anchors >= 2) {
          setMode("grid");
          agreement.observe(grid.picks);
          const items: ImportItem[] = grid.picks
            .filter((p) => agreement.isConfirmed(p.player.id) || draftedIds.has(p.player.id))
            .map((p) => ({ player: p.player, pickNo: p.pickNo }));
          setLastNames(grid.picks.map((p) => `${p.round}.${p.pick} ${p.player.name}`));
          setStatus(`Board grid · ${grid.anchors} cells labelled · ${grid.picks.length} names read · ${stamp}`);
          const fresh = items.filter((it) => !draftedIds.has(it.player.id));
          if (fresh.length > 0) {
            const out = onGrid(items);
            const changed = out ? out.added + out.filled + out.padded + out.inserted : 0;
            if (changed > 0) {
              setMarked((n) => n + changed);
              setLastPlaced(fresh.map((it) => `#${it.pickNo} ${it.player.name}`));
            }
          }
          return;
        }
        setMode("list");
        const { matches } = matchOcrLines(lines, players, draftedIds);
        agreement.observe(matches);
        // Panel order → pick order. Only names seen in two consecutive reads
        // (or already known) take part; the rest wait for the next read.
        const ordered = newestFirst ? [...matches].reverse() : matches;
        // A pick already on the board (marked in the app, or from an earlier
        // read) is an anchor the moment it shows up — no second read needed.
        const ids = ordered.map((m) => m.player.id).filter((id) => agreement.isConfirmed(id) || draftedIds.has(id));
        setLastNames(matches.map((m) => m.player.name));
        setStatus(`Read ${lines.length} lines · ${matches.length} names on screen · ${stamp}`);
        if (ids.length > 0) {
          const out = onFrame(ids);
          if (out && out.placed.length > 0) {
            setMarked((n) => n + out.placed.length);
            setLastPlaced(out.placed.map((p) => `#${p.pickNo} ${p.player.name}`));
          }
        }
      } catch (err) {
        if (!cancelled) setError(`Read failed: ${(err as Error).message}`);
      } finally {
        inFlightRef.current--;
      }
    };
    read();
    const timer = setInterval(read, READ_GAP_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase]);

  // Region drag on the preview.
  function pos(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.currentTarget.width / rect.width;
    const sy = e.currentTarget.height / rect.height;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }
  function onDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const p = pos(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  }
  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drag) return;
    const p = pos(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  }
  function onUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drag) return;
    const c = e.currentTarget;
    const x = Math.max(0, Math.min(drag.x0, drag.x1)) / c.width;
    const y = Math.max(0, Math.min(drag.y0, drag.y1)) / c.height;
    const w = Math.abs(drag.x1 - drag.x0) / c.width;
    const h = Math.abs(drag.y1 - drag.y0) / c.height;
    setDrag(null);
    if (w > 0.03 && h > 0.03) {
      const r = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
      setRegion(r);
      saveRegion(r);
      agreementRef.current = new FrameAgreement(latest.current.draftedIds); // new panel, fresh agreement
    }
  }

  const watching = phase === "watching";

  return (
    <div
      data-tour="screen-sync"
      className={`fixed bottom-4 right-4 z-40 rounded-lg border border-line bg-panel-2 shadow-2xl ${showLarge && phase !== "idle" ? "w-[560px] max-w-[calc(100vw-2rem)]" : "w-80"}`}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${watching ? "ping-dot bg-live" : phase === "idle" ? "bg-ink-faint" : "bg-warn"}`}
          aria-hidden
        />
        <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
          Screen sync{watching ? " · watching" : phase === "paused" ? " · paused" : ""}
        </p>
        {phase !== "idle" && (
          <button onClick={() => setShowLarge((v) => !v)} className="ml-auto text-xs text-ink-faint hover:text-ink">
            {showLarge ? "compact" : "preview"}
          </button>
        )}
        <button onClick={() => { stopAll(); onClose(); }} aria-label="Close screen sync" className={`font-mono text-xs text-ink-faint hover:text-ink ${phase === "idle" ? "ml-auto" : ""}`}>
          ✕
        </button>
      </div>

      <div className="px-3 py-2">
        {/* Hidden live video: the source for frames and the preview. */}
        <video ref={videoRef} className="hidden" playsInline />

        {phase === "idle" && (
          <>
            <p className="text-sm text-ink-dim">
              Share the tab or window your draft is in. The cockpit reads the pick history off the screen several times a
              second and records every pick — yours included, so you draft on the site and this app just advises. A pick
              list or a draft board grid (DraftKings) both work. Any site, no login, nothing leaves your browser.
            </p>
            <button onClick={share} className="btn-shimmer mt-3 w-full rounded-lg bg-rb py-2.5 font-display text-xl font-bold uppercase tracking-wide text-field">
              Share draft screen
            </button>
            <p className="mt-2 text-[11px] text-ink-faint">
              Pick the draft <em>tab</em> in the browser&apos;s picker. First use downloads the OCR engine (a few MB). No room
              open?{" "}
              <a href="/mock-board?autoplay=1&speed=4000" target="_blank" rel="noreferrer" className="underline hover:text-ink">
                Open a mock draft board
              </a>{" "}
              in a new tab and share that.
            </p>
          </>
        )}

        {phase !== "idle" && (
          <>
            {showLarge && (
              <canvas
                ref={previewRef}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={() => drag && setDrag(null)}
                className="w-full cursor-crosshair rounded border border-line bg-field"
                title="Drag a box around the pick history"
              />
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {phase === "sharing" || phase === "paused" ? (
                <button onClick={() => setPhase("watching")} className="rounded bg-rb px-3 py-1.5 text-sm font-semibold text-field">
                  {phase === "paused" ? "Resume" : "Watch"}
                </button>
              ) : (
                <button onClick={() => setPhase("paused")} className="rounded border border-line bg-panel px-3 py-1.5 text-sm font-semibold text-ink-dim hover:text-ink">
                  Pause
                </button>
              )}
              <button
                onClick={() => { setRegion(FULL_FRAME); saveRegion(FULL_FRAME); }}
                className="rounded border border-line bg-panel px-2 py-1.5 text-xs text-ink-dim hover:text-ink"
                title="Read the entire shared frame"
              >
                whole frame
              </button>
              <button onClick={stopAll} className="rounded border border-line bg-panel px-2 py-1.5 text-xs text-ink-dim hover:text-warn">
                stop sharing
              </button>
              {mode === "grid" ? (
                <span className="ml-auto rounded bg-live/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-live" title="Cells labelled round.pick — the labels are the pick numbers, so order doesn't matter.">
                  board grid
                </span>
              ) : (
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-dim" title="ESPN lists oldest at top, newest at bottom. Tick this if your room shows the newest pick at the top.">
                  <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} />
                  newest pick at top
                </label>
              )}
            </div>
            {lastPlaced.length > 0 && (
              <p className="mt-2 font-mono text-[11px] text-live">
                last placed: {lastPlaced.slice(-4).join(" · ")}
              </p>
            )}
            <p className="mt-2 min-h-[1rem] text-xs text-ink-dim">{status}</p>
            {(reads > 0 || marked > 0) && (
              <p className="font-mono text-[11px] text-ink-faint">
                {reads} reads · {marked} marked{lastNames.length ? ` · on screen: ${lastNames.slice(0, 6).join(", ")}${lastNames.length > 6 ? "…" : ""}` : ""}
              </p>
            )}
            {lastLines.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-ink-faint hover:text-ink">what the OCR read</summary>
                <div className="mt-1 flex gap-3">
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(JSON.stringify(lastReadRef.current, null, 1));
                        setCopiedReport(true);
                        setTimeout(() => setCopiedReport(false), 1500);
                      } catch {
                        setCopiedReport(false);
                      }
                    }}
                    className="text-[11px] text-ink-faint hover:text-ink"
                    title="Every word the OCR found in the last frame, with positions, and what the grid reader made of them"
                  >
                    {copiedReport ? "copied" : "copy OCR report"}
                  </button>
                  <button
                    onClick={() => {
                      const c = lastFrameRef.current;
                      if (!c) return;
                      const a = document.createElement("a");
                      a.href = c.toDataURL("image/png");
                      a.download = `screen-sync-frame-${Date.now()}.png`;
                      a.click();
                    }}
                    className="text-[11px] text-ink-faint hover:text-ink"
                    title="The last frame exactly as the OCR saw it (upscaled, grayscale)"
                  >
                    download last frame
                  </button>
                </div>
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-field p-2 font-mono text-[10px] leading-snug text-ink-dim">
                  {lastLines.map((l) => l.text).join("\n")}
                </pre>
              </details>
            )}
          </>
        )}
        {error && <p className="mt-2 rounded bg-warn/15 px-2 py-1 text-xs text-warn">{error}</p>}
      </div>
    </div>
  );
}
