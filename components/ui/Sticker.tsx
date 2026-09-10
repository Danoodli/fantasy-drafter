"use client";

// A position-coloured sticker, as on the physical draft board. Wrap a row, a
// chip or a card; the edge and tint follow the player's position and the theme.
import type { ReactNode } from "react";
import type { Position } from "../../lib/types";
import { POS_COLOR } from "../../lib/client/pos";

export default function Sticker({
  pos, as = "row", className = "", children, onClick, title,
}: {
  pos: Position | null;
  as?: "row" | "chip" | "card";
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const style = pos ? ({ "--sticker": POS_COLOR[pos] } as React.CSSProperties) : undefined;
  const base = as === "chip" ? "sticker-chip" : `sticker ${as === "card" ? "p-4" : "px-3 py-1.5"}`;
  const interactive = onClick ? " cursor-pointer hover:brightness-105" : "";
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} style={style} className={`${base}${interactive} text-left ${className}`}>
        {children}
      </button>
    );
  }
  return (
    <div style={style} title={title} className={`${base} ${className}`}>
      {children}
    </div>
  );
}
