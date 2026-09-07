"use client";

import { useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";

/**
 * ESPN's public headshot CDN, keyed by ESPN id, through its resizer. The
 * original is a 241 KB PNG cached for 7 seconds; at 112 px it is ~10 KB and
 * cached for a day, so every avatar on the page shares one small, warm image.
 * (Measured 2026-09-07.) Source aspect is 350×254.
 */
export const AVATAR_WIDTH = 112;
export const headshotUrl = (espnId: string | undefined, width = AVATAR_WIDTH) =>
  espnId
    ? `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${espnId}.png&w=${width}&h=${Math.round((width * 254) / 350)}`
    : null;

const LOGO_CODE: Record<string, string> = { WAS: "wsh" };
export const teamLogoUrl = (team: string) =>
  `https://a.espncdn.com/i/teamlogos/nfl/500/${(LOGO_CODE[team] ?? team).toLowerCase()}.png`;

/** Round avatar with a position-colored ring; initials when there is no photo. */
export default function Headshot({
  player,
  size = 44,
  className = "",
}: {
  player: Pick<BoardPlayer, "name" | "pos" | "ids">;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = headshotUrl(player.ids.espn);
  const color = POS_COLOR[player.pos];
  const initials = player.name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-panel-2 ${className}`}
      style={{ width: size, height: size, boxShadow: `inset 0 0 0 2px ${color}` }}
      aria-hidden
    >
      {url && !failed ? (
        /* eslint-disable-next-line @next/next/no-img-element -- remote CDN, no next/image config needed */
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          width={size}
          height={size}
          className="h-full w-full object-cover object-top"
          style={{ transform: "scale(1.25) translateY(6%)" }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="font-display text-sm font-bold" style={{ color }}>
          {initials}
        </span>
      )}
    </span>
  );
}
