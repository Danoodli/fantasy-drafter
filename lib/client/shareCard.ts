"use client";

// The flex button: render a draft recap card as a PNG for the group chat.
// Pure canvas — no library, no server, no cost.

import type { BoardPlayer, Position } from "../types";

const POS_HEX: Record<Position, string> = {
  QB: "#f45d6c",
  RB: "#3cc9a7",
  WR: "#55a9ff",
  TE: "#f5a623",
  K: "#b48bf2",
  DST: "#93a3b1",
};

export interface ShareCardData {
  title: string; // "SLOT 5 · 12TM PPR"
  grade: string;
  rank: number;
  teams: number;
  winPct: number | null;
  roster: BoardPlayer[];
  note: string | null; // e.g. steal of the draft
}

export async function renderShareCard(data: ShareCardData): Promise<Blob> {
  await document.fonts.ready;
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;

  // Field background with a subtle top glow in the grade's mood
  g.fillStyle = "#10151b";
  g.fillRect(0, 0, W, H);
  const glow = g.createLinearGradient(0, 0, 0, 420);
  glow.addColorStop(0, data.grade.startsWith("A") ? "rgba(60,201,167,.16)" : "rgba(85,169,255,.12)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, 420);

  const display = (px: number) => `700 ${px}px "Barlow Condensed", sans-serif`;
  const mono = (px: number) => `500 ${px}px "IBM Plex Mono", monospace`;

  g.fillStyle = "#8b98a5";
  g.font = mono(28);
  g.fillText("DRAFT RECAP", 72, 96);
  g.fillText(data.title.toUpperCase(), 72, 136);

  // Grade, enormous
  g.fillStyle = data.grade.startsWith("A") ? "#3cc9a7" : data.grade.startsWith("D") ? "#f45d6c" : "#edf1f4";
  g.font = display(220);
  g.fillText(data.grade, 64, 330);

  g.fillStyle = "#edf1f4";
  g.font = display(54);
  g.fillText(`FINISHED ${ordinal(data.rank)} OF ${data.teams}`, 380, 250);
  if (data.winPct != null) {
    g.fillStyle = "#3cc9a7";
    g.font = display(44);
    g.fillText(`${(data.winPct * 100).toFixed(1)}% SIMULATED WIN RATE`, 380, 310);
  }

  // Roster, two columns
  const startY = 430;
  const colX = [72, 560];
  const lineH = 56;
  data.roster.slice(0, 24).forEach((p, i) => {
    const col = i < 12 ? 0 : 1;
    const y = startY + (i % 12) * lineH;
    g.fillStyle = POS_HEX[p.pos];
    g.font = mono(24);
    g.fillText(p.pos.padEnd(3), colX[col], y);
    g.fillStyle = "#edf1f4";
    g.font = display(34);
    g.fillText(truncate(g, p.name, 330), colX[col] + 64, y + 2);
    g.fillStyle = "#5c6875";
    g.font = mono(20);
    g.fillText(p.team ?? "", colX[col] + 404, y);
  });

  if (data.note) {
    g.fillStyle = "#ffb224";
    g.font = mono(26);
    g.fillText(truncate(g, data.note, W - 144), 72, H - 132);
  }
  g.fillStyle = "#5c6875";
  g.font = mono(24);
  g.fillText("drafted with ff-algo.vercel.app", 72, H - 72);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas export failed"))), "image/png")
  );
}

function truncate(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 2 && g.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

function ordinal(n: number): string {
  const s = ["TH", "ST", "ND", "RD"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Share via the native sheet on touch devices, else download the PNG. */
export async function shareCard(data: ShareCardData): Promise<"shared" | "downloaded"> {
  const blob = await renderShareCard(data);
  const file = new File([blob], "draft-recap.png", { type: "image/png" });
  const touch = typeof window !== "undefined" && "ontouchstart" in window;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Draft recap" });
      return "shared";
    } catch {
      // user cancelled — fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "draft-recap.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "downloaded";
}
