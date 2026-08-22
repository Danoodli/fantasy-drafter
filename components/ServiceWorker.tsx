"use client";

import { useEffect } from "react";

/** Registers the offline cache in production. Dev stays uncached for HMR. */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // offline still mostly works via the browser HTTP cache
    });
  }, []);
  return null;
}
