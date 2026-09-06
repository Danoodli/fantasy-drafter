"use client";

// Screen sync, the I/O half: share the draft-room tab or window, sample the
// chosen region every couple of seconds, OCR it in a Tesseract worker, and
// hand plain text lines to the pure matcher. Nothing here knows about
// players; nothing in the matcher knows about cameras.
//
// Tesseract.js runs entirely in the browser (WASM in a worker). Its worker,
// core and English data load lazily from its default free CDN the first time
// screen sync starts — a few MB, cached by the browser afterwards. No server,
// no keys.

import type { OcrLine } from "../draft/ocrMatch";

/** Fractions of the captured frame: the panel the user dragged out. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_FRAME: Region = { x: 0, y: 0, w: 1, h: 1 };
const REGION_KEY = "draft-cockpit-screen-region-v1";

export function loadRegion(): Region | null {
  try {
    const raw = localStorage.getItem(REGION_KEY);
    return raw ? (JSON.parse(raw) as Region) : null;
  } catch {
    return null;
  }
}

export function saveRegion(region: Region): void {
  try {
    localStorage.setItem(REGION_KEY, JSON.stringify(region));
  } catch {
    // fine — the user drags it again next time
  }
}

export function captureSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** Ask the browser to share a tab/window/screen. Resolves once video is flowing. */
export async function startCapture(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 4, max: 8 } },
    audio: false,
    // Chrome-only hints: prefer the tab picker, don't offer the current tab.
    ...({ preferCurrentTab: false, selfBrowserSurface: "exclude", surfaceSwitching: "include" } as object),
  });
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1500);
    });
  }
  return stream;
}

export function stopCapture(stream: MediaStream | null, video: HTMLVideoElement | null): void {
  stream?.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}

/**
 * Grab the region from the live video as an upscaled, high-contrast canvas.
 * UI fonts in a shared tab are small; 2× and grayscale/contrast stretch make
 * Tesseract markedly more reliable on them.
 */
export function grabFrame(video: HTMLVideoElement, region: Region, scale = 2): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = Math.floor(region.x * vw);
  const sy = Math.floor(region.y * vh);
  const sw = Math.max(1, Math.floor(region.w * vw));
  const sh = Math.max(1, Math.floor(region.h * vh));
  const canvas = document.createElement("canvas");
  canvas.width = sw * scale;
  canvas.height = sh * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  // Grayscale + contrast stretch. Dark-mode draft rooms (light text on dark)
  // are inverted so the OCR sees black text on white, its training domain.
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  const mean = sum / (d.length / 4);
  const invert = mean < 110;
  for (let i = 0; i < d.length; i += 4) {
    let g = d[i];
    if (invert) g = 255 - g;
    g = Math.max(0, Math.min(255, (g - 128) * 1.35 + 128));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

type TesseractModule = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;
type TesseractScheduler = ReturnType<TesseractModule["createScheduler"]>;

/** Parallel OCR workers: reads overlap, so the room is sampled ~2× a second. */
export const OCR_WORKERS = 2;

let schedulerPromise: Promise<TesseractScheduler> | null = null;

async function makeWorker(T: TesseractModule, onProgress?: (status: string, progress: number) => void): Promise<TesseractWorker> {
  const worker = await T.createWorker("eng", 1, {
    logger: (m) => onProgress?.(m.status, m.progress),
  });
  await worker.setParameters({
    // Names, punctuation, digits — nothing else. Keeps "Ja'Marr" and "D/ST" readable.
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'’.-/#()&, ",
    preserve_interword_spaces: "1",
    user_defined_dpi: "144",
  });
  return worker;
}

/** One shared scheduler with OCR_WORKERS workers, created on first use (lazy import keeps it out of the main bundle). */
export function getOcrScheduler(onProgress?: (status: string, progress: number) => void): Promise<TesseractScheduler> {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const T = await import("tesseract.js");
      const scheduler = T.createScheduler();
      const workers = await Promise.all(Array.from({ length: OCR_WORKERS }, (_, i) => makeWorker(T, i === 0 ? onProgress : undefined)));
      for (const w of workers) scheduler.addWorker(w);
      return scheduler;
    })().catch((err) => {
      schedulerPromise = null;
      throw err;
    });
  }
  return schedulerPromise;
}

export async function terminateOcr(): Promise<void> {
  const p = schedulerPromise;
  schedulerPromise = null;
  if (p) {
    try {
      await (await p).terminate();
    } catch {
      // already gone
    }
  }
}

interface TessLine {
  text: string;
  confidence: number;
  bbox: { y0: number };
}
interface TessBlock {
  paragraphs?: { lines?: TessLine[] }[];
}

/** OCR a canvas into lines with vertical order preserved. */
export async function recognizeLines(scheduler: TesseractScheduler, canvas: HTMLCanvasElement): Promise<OcrLine[]> {
  const { data } = await scheduler.addJob("recognize", canvas, {}, { text: true, blocks: true });
  const out: OcrLine[] = [];
  const blocks = (data as unknown as { blocks?: TessBlock[] | null }).blocks;
  if (blocks && blocks.length) {
    for (const b of blocks)
      for (const p of b.paragraphs ?? [])
        for (const l of p.lines ?? []) {
          if (l.text?.trim()) out.push({ text: l.text.trim(), confidence: l.confidence ?? 0, y: l.bbox?.y0 ?? out.length });
        }
  }
  if (out.length === 0 && data.text) {
    data.text.split("\n").forEach((t, i) => {
      if (t.trim()) out.push({ text: t.trim(), confidence: 50, y: i });
    });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}
