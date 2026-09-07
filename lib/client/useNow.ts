"use client";

import { useEffect, useState } from "react";

/** Wall-clock for relative labels, read in an effect (render stays pure); null before mount. */
export function useNow(everyMs = 60_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clock hydration after mount
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
