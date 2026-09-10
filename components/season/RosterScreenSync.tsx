"use client";

// Screen sync tab of RosterImport: share the tab showing your roster, click
// Read, review, Apply. One frame per click — a roster page is static, so the
// draft's continuous loop and two-frame agreement are unnecessary here. The
// OCR engine (Tesseract.js, browser-only, lazily loaded from its CDN) and the
// frame pipeline are the draft's, unchanged.

import { useEffect, useRef, useState } from "react";
import type { Board } from "../../lib/types";
import { applyRoster, type SavedTeam } from "../../lib/client/teams";
import { readRosterLines, type OcrRosterEntry } from "../../lib/season/rosterOcr";
import { POS_COLOR } from "../../lib/client/pos";
import {
  FULL_FRAME, captureSupported, getOcrScheduler, grabFrame, recognizeLines, startCapture, stopCapture,
} from "../../lib/client/screenCapture";

export default function RosterScreenSync({ board, team, onChange }: { board: Board; team: SavedTeam; onChange: (t: SavedTeam) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<{ entries: OcrRosterEntry[]; hasSlots: boolean; lines: string[] } | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());

  useEffect(() => () => stopCapture(streamRef.current, videoRef.current), []);

  async function share() {
    setError(null);
    if (!captureSupported()) {
      setError("This browser can't share a screen. Chrome, Edge or Safari 17+ on desktop can.");
      return;
    }
    try {
      const stream = await startCapture(videoRef.current!);
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { stopCapture(streamRef.current, videoRef.current); streamRef.current = null; setSharing(false); setStatus("Sharing ended."); });
      setSharing(true);
      setStatus("Make the roster fill the shared window, then Read.");
      getOcrScheduler((s, p) => setStatus(`Loading OCR engine… ${s} ${Math.round(p * 100)}%`)).then(
        () => setStatus((cur) => (cur.startsWith("Loading OCR") ? "OCR engine ready. Make the roster fill the shared window, then Read." : cur)),
        (err) => setError(`OCR engine failed to load: ${(err as Error).message}`)
      );
    } catch (err) {
      setError(`Couldn't start sharing: ${(err as Error).message}`);
    }
  }

  async function readOnce() {
    const video = videoRef.current;
    if (!video) { setError("No video element — reload the page."); return; }
    setError(null);
    setStatus("Reading…");
    const frame = grabFrame(video, FULL_FRAME);
    if (!frame) { setError("No video frame yet — try again in a second."); return; }
    try {
      const lines = await recognizeLines(await getOcrScheduler(), frame);
      const r = readRosterLines(lines, board.players);
      setRead({ ...r, lines: lines.map((l) => l.text) });
      setDisabled(new Set());
      setStatus(`Read ${r.entries.length} player${r.entries.length === 1 ? "" : "s"} from ${lines.length} lines.`);
    } catch (err) {
      setError(`Read failed: ${(err as Error).message}`);
    }
  }

  function apply() {
    if (!read) return;
    const kept = read.entries.filter((e) => !disabled.has(e.player.id));
    const slots: Record<string, OcrRosterEntry["slot"]> = {};
    if (read.hasSlots) for (const e of kept) slots[e.player.id] = e.slot;
    onChange(applyRoster(team, kept.map((e) => e.player.id), "ocr", read.hasSlots ? slots : undefined));
    setRead(null);
  }

  function stop() {
    stopCapture(streamRef.current, videoRef.current);
    streamRef.current = null;
    setSharing(false);
    setStatus("");
  }

  return (
    <div className="mt-3 space-y-2 text-sm">
      <video ref={videoRef} className="hidden" playsInline />
      <div className="flex gap-2">
        {!sharing ? (
          <button onClick={share} className="rounded bg-panel px-3 py-1 font-semibold text-ink-dim hover:text-ink">Share screen</button>
        ) : (
          <>
            <button onClick={readOnce} className="rounded bg-rb px-3 py-1 font-semibold text-field">Read</button>
            <button onClick={stop} className="rounded border border-line px-3 py-1 text-ink-dim hover:text-ink">Stop</button>
          </>
        )}
      </div>
      {status && <p className="text-xs text-ink-faint">{status}</p>}
      {error && <p className="text-xs text-warn">{error}</p>}
      {read && (
        <>
          {read.entries.length === 0 ? (
            <p className="text-xs text-ink-dim">No player names recognised. Zoom the page so names are at least 12px tall and read again.</p>
          ) : (
            <ol className="divide-y divide-line rounded border border-line">
              {read.entries.map((e) => (
                <li key={e.player.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    checked={!disabled.has(e.player.id)}
                    onChange={(ev) => setDisabled((prev) => { const n = new Set(prev); if (ev.target.checked) n.delete(e.player.id); else n.add(e.player.id); return n; })}
                    aria-label={`Keep ${e.player.name}`}
                  />
                  <span className="w-10 shrink-0 font-mono text-[10px] text-ink-faint">{read.hasSlots ? e.slot : ""}</span>
                  <span className="font-mono text-[10px]" style={{ color: POS_COLOR[e.player.pos] }}>{e.player.pos}</span>
                  <span>{e.player.name}</span>
                  <span className="ml-auto max-w-[45%] truncate font-mono text-[10px] text-ink-faint" title={e.line}>{e.line}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-faint">{read.hasSlots ? "Starters and bench read from the page." : "No slot labels seen — the engine will pick the lineup."}</p>
            <button onClick={apply} disabled={read.entries.length === 0} className="rounded bg-rb px-4 py-2 text-sm font-semibold text-field disabled:opacity-40">
              Replace roster with {read.entries.filter((e) => !disabled.has(e.player.id)).length} players
            </button>
          </div>
        </>
      )}
    </div>
  );
}
