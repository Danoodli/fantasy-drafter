"use client";

import { useState } from "react";
import type { BoardPlayer } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";

/** ESPN's public headshot CDN, keyed by ESPN id — the same image the player card shows. */
export const headshotUrl = (espnId: string | undefined) =>
  espnId ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png` : null;

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
