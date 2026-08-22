"use client";

// Exposure across your whole draft portfolio: which players you keep ending
// up with, which stacks you're building, where you're concentrated. The tool
// serious best-ball players manage by. All on-device, from draft history.

import { useEffect, useMemo, useState } from "react";
import type { Board, BoardPlayer } from "../lib/types";
import { loadHistory } from "../lib/client/history";
import { computePortfolio } from "../lib/client/portfolio";
import { POS_COLOR } from "../lib/client/pos";
import { DEFAULT_CONFIG } from "../lib/client/config";
import PlayerModal from "./PlayerModal";

export default function Portfolio({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [modalPlayer, setModalPlayer] = useState<BoardPlayer | null>(null);
  const drafts = useMemo(() => loadHistory(), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/board-ppr.json")
      .then((r) => r.json())
      .then((b) => !cancelled && setBoard(b))
      .catch(() => !cancelled && setBoard(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = useMemo(
    () => new Map<string, BoardPlayer>((board?.players ?? []).map((p) => [p.id, p])),
    [board]
  );
  const portfolio = useMemo(() => computePortfolio(drafts, byId), [drafts, byId]);
  const maxCount = portfolio.players[0]?.count ?? 1;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-10 pt-4">
      <header className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <h1 className="font-display text-4xl font-bold uppercase tracking-tight">Portfolio</h1>
        <p className="text-ink-dim">
          exposure across {portfolio.totalDrafts} draft{portfolio.totalDrafts === 1 ? "" : "s"}
        </p>
        <button
          onClick={onClose}
          className="ml-auto rounded border border-line bg-panel px-4 py-2 text-sm text-ink-dim hover:text-ink"
        >
          Back
        </button>
      </header>

      {portfolio.totalDrafts === 0 ? (
        <p className="mt-6 text-ink-dim">
          No drafts saved yet. Run a draft — every one saves itself here automatically.
        </p>
      ) : (
        <>
          {portfolio.stacks.length > 0 && (
            <section className="mt-4">
              <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">Your stacks</p>
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {portfolio.stacks.slice(0, 8).map((s) => (
                  <li key={s.label} className="rounded-lg bg-panel px-3 py-1.5 text-sm">
                    ⚡ {s.label}
                    <span className="ml-1.5 font-mono text-xs text-ink-faint">×{s.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {portfolio.teams.length > 0 && (
            <section className="mt-4">
              <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
                Team concentration (2+ players from one team)
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {portfolio.teams.slice(0, 10).map((t) => (
                  <li key={t.team} className="rounded bg-panel px-2.5 py-1 font-mono text-sm">
                    {t.team} <span className="text-ink-faint">×{t.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-5">
            <p className="font-mono text-xs uppercase tracking-widest text-ink-dim">
              Player exposure
            </p>
            <ul className="stagger mt-2 space-y-1">
              {portfolio.players.slice(0, 60).map((row) => {
                const player = byId.get(row.id);
                return (
                  <li key={row.id} className="flex items-center gap-2 text-sm">
                    <span
                      className="w-8 shrink-0 font-mono text-[11px]"
                      style={{ color: row.pos ? POS_COLOR[row.pos] : undefined }}
                    >
                      {row.pos ?? "?"}
                    </span>
                    <button
                      onClick={() => player && setModalPlayer(player)}
                      className="min-w-0 truncate text-left hover:underline"
                      disabled={!player}
                    >
                      {row.name}
                    </button>
                    {row.team && (
                      <span className="font-mono text-[10px] text-ink-faint">{row.team}</span>
                    )}
                    <div className="ml-auto flex w-40 shrink-0 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(row.count / maxCount) * 100}%`,
                            background: row.pos ? POS_COLOR[row.pos] : "var(--color-ink-dim)",
                          }}
                        />
                      </div>
                      <span className="w-16 text-right font-mono text-xs text-ink-dim">
                        {row.count}/{portfolio.totalDrafts} · {Math.round(row.pct * 100)}%
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {modalPlayer && board && (
        <PlayerModal
          player={modalPlayer}
          ctx={{
            currentPick: 1,
            nextPick: 1,
            drift: {},
            tierMatesLeft: board.players.filter(
              (a) => a.pos === modalPlayer.pos && a.tier === modalPlayer.tier && a.id !== modalPlayer.id
            ).length,
          }}
          config={DEFAULT_CONFIG}
          drafted
          canUnmark={false}
          readonly
          wireItem={modalPlayer.news ? { ...modalPlayer.news, href: null } : null}
          myTurn={false}
          onMark={() => {}}
          onUnmark={() => {}}
          onClose={() => setModalPlayer(null)}
        />
      )}
    </main>
  );
}
