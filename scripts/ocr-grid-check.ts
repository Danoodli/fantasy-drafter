// End-to-end check of screen sync's grid reader against the mock DraftKings
// board (app/mock-board): render it in headless Chromium, run the frame
// through the SAME pixel pipeline screen sync uses (enhancePixels, upscaled),
// OCR it with the same Tesseract parameters, and hand the words to readGrid.
// Prints how many labelled cells were found and which picks were read right,
// wrong or missed against the page's ground truth.
//
//   pnpm dev                     # in another shell
//   pnpm ocr:check               # defaults: 80 picks, scale 2
//   pnpm ocr:check --scale 3 --psm 11 --url "http://localhost:3000/mock-board?picks=60&seed=3"
//   pnpm ocr:check --replay /tmp/o2   # re-score saved words (no browser, no OCR)
//
// Dev-only: needs Playwright's Chromium (or the machine's Chrome) and
// downloads Tesseract's English data once into .tesseract-cache/. Never runs
// in CI or in the app.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createWorker } from "tesseract.js";
import type { Board } from "../lib/types";
import { readGrid, type OcrWord } from "../lib/draft/ocrGrid";
import { enhancePixels, flattenBlocks, type TessBlock } from "../lib/client/screenCapture";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const url = arg("url", "http://localhost:3000/mock-board?picks=80&autoplay=0&seed=7");
const scale = Number(arg("scale", "2"));
const psm = arg("psm", "");
const dpr = Number(arg("dpr", "1"));
const width = Number(arg("width", "1440"));
const outDir = arg("out", "/tmp");
const replay = arg("replay", "");
const thresh = arg("thresh", ""); // Tesseract thresholding_method: 0 Otsu (default), 1 Leptonica Otsu, 2 Sauvola (adaptive)

interface Truth {
  teams: number;
  rounds: number;
  picks: { pickNo: number; round: number; pick: number; id: string; name: string }[];
  /** Pick numbers whose cell is inside the grid's visible box (the board scrolls). */
  visible?: number[];
}

async function main() {
  const board: Board = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "board-ppr.json"), "utf8"));
  if (replay) {
    const words: OcrWord[] = JSON.parse(readFileSync(join(replay, "mock-words.json"), "utf8"));
    const truth: Truth = JSON.parse(readFileSync(join(replay, "mock-truth.json"), "utf8"));
    console.log(`replay     ${replay}`);
    report(readGrid(words, board.players, { teams: truth.teams }), truth, words);
    return;
  }

  // Playwright's own Chromium if it is installed, else the machine's Chrome (no download).
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: dpr });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("[data-mock-grid] [data-overall]", { timeout: 60000 }); // dev server may compile first
  await page.waitForTimeout(2500); // headshots
  const truth: Truth = JSON.parse(await page.locator("#mock-truth").evaluate((el) => el.textContent ?? "{}"));
  truth.visible = await page.evaluate(() => {
    const grid = document.querySelector("[data-mock-grid]")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("[data-mock-grid] [data-overall]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        return cx >= grid.left && cx <= grid.right && cy >= grid.top && cy <= grid.bottom;
      })
      .map((el) => Number(el.dataset.overall));
  });
  writeFileSync(join(outDir, "mock-truth.json"), JSON.stringify(truth));
  const grid = page.locator("[data-mock-grid]");
  const raw = await grid.screenshot({ type: "png" });
  writeFileSync(join(outDir, "mock-raw.png"), raw);

  // Same pipeline as grabFrame: upscale, grayscale, contrast stretch — run in the page so canvas does the work.
  const enhanced: string = await page.evaluate(
    async ({ dataUrl, scale, fnSrc }) => {
      const enhance = new Function(`return (${fnSrc})`)() as (d: Uint8ClampedArray) => void;
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      enhance(data.data);
      ctx.putImageData(data, 0, 0);
      return canvas.toDataURL("image/png");
    },
    { dataUrl: `data:image/png;base64,${raw.toString("base64")}`, scale, fnSrc: enhancePixels.toString() }
  );
  await browser.close();
  const png = Buffer.from(enhanced.split(",")[1], "base64");
  writeFileSync(join(outDir, "mock-enhanced.png"), png);

  const worker = await createWorker("eng", 1, { cachePath: join(process.cwd(), ".tesseract-cache"), logger: () => {} });
  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'’.-/#()&, ",
    preserve_interword_spaces: "1",
    user_defined_dpi: "144",
    ...(psm ? { tessedit_pageseg_mode: psm as never } : {}),
    ...(thresh ? ({ thresholding_method: thresh } as never) : {}),
  });
  const t0 = Date.now();
  const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
  const ms = Date.now() - t0;
  await worker.terminate();
  const { words, lines } = flattenBlocks((data as unknown as { blocks?: TessBlock[] | null }).blocks, data.text);
  writeFileSync(join(outDir, "mock-words.json"), JSON.stringify(words, null, 1));

  console.log(`url        ${url}`);
  console.log(`frame      ${width}px wide @dpr ${dpr}, scale ${scale}, psm ${psm || "default"}, thresh ${thresh || "default"} — OCR ${ms} ms, ${lines.length} lines, ${words.length} words`);
  report(readGrid(words, board.players, { teams: truth.teams }), truth, words);
  console.log(`images     ${outDir}/mock-raw.png · ${outDir}/mock-enhanced.png · words in ${outDir}/mock-words.json`);
}

function report(read: ReturnType<typeof readGrid>, truth: Truth, words: OcrWord[]) {
  const byPick = new Map(read.picks.map((p) => [p.pickNo, p]));
  const shown = truth.visible ? new Set(truth.visible) : null;
  const visible = shown ? truth.picks.filter((t) => shown.has(t.pickNo)) : truth.picks;
  let right = 0, wrong = 0, missed = 0;
  const wrongs: string[] = [];
  const misses: string[] = [];
  for (const t of visible) {
    const got = byPick.get(t.pickNo);
    if (!got) { missed++; misses.push(`${t.round}.${t.pick} ${t.name}`); continue; }
    if (got.player.id === t.id) right++;
    else { wrong++; wrongs.push(`${t.round}.${t.pick} truth ${t.name} → read ${got.player.name} (${got.text})`); }
  }
  const phantoms = read.picks.filter((p) => !visible.some((t) => t.pickNo === p.pickNo)).map((p) => `${p.round}.${p.pick} ${p.player.name} (${p.text})`);
  const labelWords = words.filter((w) => /^\d{1,2}[.,:]\d{1,2}$/.test(w.text)).length;
  console.log(`labels     ${read.anchors} anchors (${labelWords} label-shaped words) for ${visible.length} visible filled cells${shown ? ` (${truth.picks.length} drafted)` : ""}`);
  console.log(`picks      ${right} right · ${wrong} wrong · ${missed} missed · ${phantoms.length} phantom`);
  if (wrongs.length) console.log(`WRONG\n  ${wrongs.join("\n  ")}`);
  if (phantoms.length) console.log(`PHANTOM\n  ${phantoms.join("\n  ")}`);
  if (misses.length) console.log(`missed\n  ${misses.slice(0, 40).join("\n  ")}${misses.length > 40 ? `\n  …${misses.length - 40} more` : ""}`);
  if (wrong > 0 || phantoms.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
