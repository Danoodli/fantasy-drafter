"use client";

// LIVE insider wire: Bluesky's Jetstream — a free public WebSocket firehose
// filtered to our reporters' accounts. True push: the moment Rapoport posts,
// the socket delivers it. No polling gap right before your pick. The 10-min
// poll stays as the fallback/backfill; this stream is the tip of the spear.

import type { BoardPlayer } from "../types";
import { matchNewsToPlayers, type PlayerNews } from "./espnNews";

const JETSTREAM = "wss://jetstream2.us-east.bsky.network/subscribe";
const RECONNECT_MS = 15_000;

interface JetstreamEvent {
  did?: string;
  kind?: string;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: { text?: string; createdAt?: string };
  };
}

async function resolveDids(handles: string[]): Promise<Map<string, string>> {
  const didToHandle = new Map<string, string>();
  await Promise.all(
    handles.map(async (handle) => {
      try {
        const res = await fetch(
          `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
        );
        if (!res.ok) return;
        const { did } = (await res.json()) as { did?: string };
        if (did) didToHandle.set(did, handle);
      } catch {
        // dead handle — skip
      }
    })
  );
  return didToHandle;
}

/**
 * Open the live wire. Calls `onNews` with player-matched items as posts
 * arrive. Returns a cleanup function. Reconnects itself until cleaned up.
 */
export function connectWireStream(
  players: BoardPlayer[],
  handles: string[],
  onNews: (matched: Map<string, PlayerNews>) => void
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  resolveDids(handles).then((didToHandle) => {
    if (closed || didToHandle.size === 0) return;
    const params = [...didToHandle.keys()].map((d) => `wantedDids=${d}`).join("&");
    const url = `${JETSTREAM}?wantedCollections=app.bsky.feed.post&${params}`;

    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket(url);
      } catch {
        reconnectTimer = setTimeout(open, RECONNECT_MS);
        return;
      }
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(String(e.data)) as JetstreamEvent;
          if (ev.kind !== "commit" || ev.commit?.operation !== "create") return;
          if (ev.commit.collection !== "app.bsky.feed.post") return;
          const text = ev.commit.record?.text ?? "";
          if (!text) return;
          const handle = ev.did ? didToHandle.get(ev.did) : undefined;
          const matched = matchNewsToPlayers(
            [
              {
                headline: text.length > 140 ? `${text.slice(0, 140)}…` : text,
                description: text,
                published: ev.commit.record?.createdAt ?? new Date().toISOString(),
                href:
                  handle && ev.commit.rkey
                    ? `https://bsky.app/profile/${handle}/post/${ev.commit.rkey}`
                    : null,
                athleteIds: [],
              },
            ],
            players,
            48
          );
          if (matched.size > 0) onNews(matched);
        } catch {
          // malformed frame — ignore
        }
      };
      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    open();
  });

  return () => {
    closed = true;
    clearTimeout(reconnectTimer);
    ws?.close();
  };
}
