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
// a name at MY slot is never placed — it waits in the panel for me to Draft
// or Ignore, with a placeholder holding the spot so everyone after me still
// lands on the right team. Two consecutive reads must agree before a name
// counts. Pick numbers on screen are never read: OCR junk in front of a name
// is not a pick number.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPlayer } from "../lib/types";
import type { HeldPick, SequenceOutcome } from "../lib/client/useDraft";
import { FrameAgreement, matchOcrLines, type OcrLine } from "../lib/draft/ocrMatch";
import { POS_COLOR } from "../lib/client/pos";
import {
  FULL_FRAME,
  OCR_WORKERS,
  captureSupported,
  getOcrScheduler,
  grabFrame,
  loadRegion,
  recognizeLines,
  saveRegion,
  startCapture,
  stopCapture,
  type Region,
} from "../lib/client/screenCapture";

interface Props {
  players: BoardPlayer[];
  draftedIds: Set<string>;
  /** Apply one ordered read of the panel. Returns what was placed and what waits on me. */
  onFrame: (playerIds: string[], ignored: Set<string>) => SequenceOutcome | void;
  /** The user confirms a held name as their own pick at that pick number. */
  onDraftMine: (player: BoardPlayer, pickNo: number) => void;
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

export default function ScreenSync({ players, draftedIds, onFrame, onDraftMine, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const agreementRef = useRef<FrameAgreement | null>(null);
  const inFlightRef = useRef(0);
  const frameSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const ignoredRef = useRef(new Set<string>());
  /** Render-side mirror of ignoredRef (the loop reads the ref; the list reads this). */
  const [ignoredIds, setIgnoredIds] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("idle");
  const [region, setRegion] = useState<Region>(() => loadRegion() ?? FULL_FRAME);
  const [newestFirst, setNewestFirstState] = useState<boolean>(loadNewestFirst);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [lastLines, setLastLines] = useState<OcrLine[]>([]);
  const [lastNames, setLastNames] = useState<string[]>([]);
  const [reads, setReads] = useState(0);
  const [marked, setMarked] = useState(0);
  const [held, setHeld] = useState<HeldPick[]>([]);
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
  const latest = useRef({ players, draftedIds, region, newestFirst, onFrame });
  useEffect(() => {
    latest.current = { players, draftedIds, region, newestFirst, onFrame };
  }, [players, draftedIds, region, newestFirst, onFrame]);

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
      setStatus("Drag a box around the pick history (drafted players only), then Watch.");
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
      const { players, draftedIds, region, newestFirst, onFrame } = latest.current;
      const frame = grabFrame(video, region);
      if (!frame) return;
      const seq = ++frameSeqRef.current;
      inFlightRef.current++;
      try {
        const scheduler = await getOcrScheduler();
        const lines = await recognizeLines(scheduler, frame);
        if (cancelled || seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        const { matches } = matchOcrLines(lines, players, draftedIds);
        const agreement = agreementRef.current!;
        agreement.observe(matches);
        // Panel order → pick order. Only names seen in two consecutive reads
        // (or already known) take part; the rest wait for the next read.
        const ordered = newestFirst ? [...matches].reverse() : matches;
        const ids = ordered.map((m) => m.player.id).filter((id) => agreement.isConfirmed(id) && !ignoredRef.current.has(id));
        setReads((n) => n + 1);
        setLastLines(lines);
        setLastNames(matches.map((m) => m.player.name));
        setStatus(`Read ${lines.length} lines · ${matches.length} names on screen · ${new Date().toLocaleTimeString()}`);
        if (ids.length > 0) {
          const out = onFrame(ids, ignoredRef.current);
          if (out) {
            setHeld(out.held);
            if (out.inserted + out.filled > 0) setMarked((n) => n + out.inserted + out.filled);
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
  const visibleHeld = held.filter((h) => !draftedIds.has(h.player.id) && !ignoredIds.has(h.player.id));

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
              second and marks new picks in order — any site, no login, nothing leaves your browser. Your own picks are
              never made for you.
            </p>
            <button onClick={share} className="btn-shimmer mt-3 w-full rounded-lg bg-rb py-2.5 font-display text-xl font-bold uppercase tracking-wide text-field">
              Share draft screen
            </button>
            <p className="mt-2 text-[11px] text-ink-faint">
              Pick the draft <em>tab</em> in the browser&apos;s picker. First use downloads the OCR engine (a few MB).
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
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-dim" title="ESPN lists oldest at top, newest at bottom. Tick this if your room shows the newest pick at the top.">
                <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} />
                newest pick at top
              </label>
            </div>
            {visibleHeld.length > 0 && (
              <div className="mt-2 rounded border border-warn/40 bg-warn/10 p-2">
                <p className="text-xs text-warn">Your pick — screen sync never fills your slot. Seen on screen:</p>
                <ul className="mt-1 space-y-1">
                  {visibleHeld.map(({ player, pickNo }) => (
                    <li key={player.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-[10px] text-ink-faint">#{pickNo}</span>
                      <span className="font-mono text-[10px]" style={{ color: POS_COLOR[player.pos] }}>{player.pos}</span>
                      <span>{player.name}</span>
                      <span className="ml-auto flex gap-1">
                        <button
                          onClick={() => {
                            setHeld((prev) => prev.filter((h) => h.player.id !== player.id));
                            onDraftMine(player, pickNo);
                          }}
                          className="rounded bg-rb px-2 py-0.5 text-xs font-semibold text-field"
                          title="That's my pick — put him on my roster at this pick"
                        >
                          Draft
                        </button>
                        <button
                          onClick={() => {
                            ignoredRef.current.add(player.id);
                            setIgnoredIds(new Set(ignoredRef.current));
                            setHeld((prev) => prev.filter((h) => h.player.id !== player.id));
                          }}
                          className="rounded border border-line px-2 py-0.5 text-xs text-ink-dim hover:text-ink"
                          title="Misread — never mark this name from the screen"
                        >
                          Ignore
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11px] text-ink-faint">The slot is held for you; everyone after you is already placed.</p>
              </div>
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
