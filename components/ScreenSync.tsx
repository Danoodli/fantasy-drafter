"use client";

// Screen sync: share the draft-room tab, drag a box around its drafted-players
// panel, and the cockpit reads new picks off the screen every few seconds.
// Works for any site — ESPN, Yahoo, Underdog, DraftKings, a league-mate's
// screen share — because it never talks to the site at all.
//
// Flow: Share → (optional) drag region → Watch. Two consecutive reads must
// agree before a name is marked; every mark shows in the toast with undo.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPlayer } from "../lib/types";
import type { ImportItem } from "../lib/client/useDraft";
import { FrameAgreement, matchOcrLines, type OcrLine } from "../lib/draft/ocrMatch";
import {
  FULL_FRAME,
  captureSupported,
  getOcrWorker,
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
  teams: number;
  onImport: (items: ImportItem[], source: string) => void;
  onClose: () => void;
}

type Phase = "idle" | "sharing" | "watching" | "paused";

const INTERVAL_MS = 2500;
const PREVIEW_W = 520;

export default function ScreenSync({ players, draftedIds, teams, onImport, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const agreementRef = useRef<FrameAgreement | null>(null);
  const busyRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [region, setRegion] = useState<Region>(() => loadRegion() ?? FULL_FRAME);
  const [newestFirst, setNewestFirst] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [lastLines, setLastLines] = useState<OcrLine[]>([]);
  const [lastNames, setLastNames] = useState<string[]>([]);
  const [reads, setReads] = useState(0);
  const [marked, setMarked] = useState(0);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [showLarge, setShowLarge] = useState(true);

  // Latest props for the async loop without re-subscribing every render.
  const latest = useRef({ players, draftedIds, teams, region, newestFirst, onImport });
  useEffect(() => {
    latest.current = { players, draftedIds, teams, region, newestFirst, onImport };
  }, [players, draftedIds, teams, region, newestFirst, onImport]);

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
      setStatus("Drag a box around the drafted-players list, then Watch. Or watch the whole frame.");
      // Warm the OCR engine while the user picks the region.
      getOcrWorker((s, p) => setStatus(`Loading OCR engine… ${s} ${Math.round(p * 100)}%`)).then(
        () => setStatus((cur) => (cur.startsWith("Loading OCR") ? "OCR engine ready. Drag a box, then Watch." : cur)),
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

  // The read loop.
  useEffect(() => {
    if (phase !== "watching") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || busyRef.current) return;
      busyRef.current = true;
      try {
        const video = videoRef.current;
        if (!video) return;
        const { players, draftedIds, teams, region, newestFirst, onImport } = latest.current;
        const frame = grabFrame(video, region);
        if (!frame) return;
        const worker = await getOcrWorker();
        const lines = await recognizeLines(worker, frame);
        if (cancelled) return;
        const { matches } = matchOcrLines(lines, players, draftedIds, { teams });
        const fresh = agreementRef.current?.observe(matches) ?? [];
        setReads((n) => n + 1);
        setLastLines(lines);
        setLastNames(matches.map((m) => m.player.name));
        setStatus(`Read ${lines.length} lines · ${matches.length} names on screen · ${new Date().toLocaleTimeString()}`);
        if (fresh.length > 0) {
          // Numbered picks land exactly; unnumbered ones follow panel order.
          const numbered = fresh.filter((m) => m.pickNo != null);
          const rest = fresh.filter((m) => m.pickNo == null).sort((a, b) => (newestFirst ? b.y - a.y : a.y - b.y));
          const items: ImportItem[] = [...numbered, ...rest].map((m) => ({ player: m.player, pickNo: m.pickNo }));
          onImport(items, "Screen sync");
          setMarked((n) => n + items.length);
        }
      } catch (err) {
        if (!cancelled) setError(`Read failed: ${(err as Error).message}`);
      } finally {
        busyRef.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, INTERVAL_MS);
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
              Share the tab or window your draft is in. The cockpit reads the drafted-players list off the screen every
              few seconds and marks new names — any site, no login, nothing leaves your browser.
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
                title="Drag a box around the drafted-players list"
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
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-dim" title="Only matters when the panel shows no pick numbers">
                <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} />
                newest at top
              </label>
            </div>
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
