"use client";

// One confirm dialog for every destructive or navigational action in the app —
// leaving a draft, resetting it, auto-completing it. Replaces window.confirm,
// which looked foreign, blocked the render loop, and could not be styled.
//
// Keyboard: Esc cancels. Enter activates the focused button — the cancel
// button takes focus for dangerous actions so a stray Enter never destroys
// anything; the confirm button takes it otherwise.

import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: confirm button in warn color, cancel button gets focus. */
  danger?: boolean;
  onConfirm: () => void;
}

interface Props {
  request: ConfirmRequest | null;
  onClose: () => void;
}

export default function ConfirmDialog({ request, onClose }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    (request.danger ? cancelRef : confirmRef).current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, onClose]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-field/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // Keep Enter/⌘Z inside the dialog: the cockpit's global shortcuts must
      // not draft a player or undo a pick while a question is on screen.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="rise-in w-full max-w-sm rounded-lg border border-line bg-panel-2 p-5 shadow-2xl"
      >
        <h2 id="confirm-title" className="font-display text-2xl font-bold uppercase leading-tight">
          {request.title}
        </h2>
        {request.body && <p className="mt-2 text-sm leading-snug text-ink-dim">{request.body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onClose}
            className="rounded border border-line bg-panel px-3 py-2 text-sm font-semibold text-ink-dim hover:text-ink"
          >
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            onClick={() => {
              request.onConfirm();
              onClose();
            }}
            className={`rounded px-3 py-2 text-sm font-semibold text-field ${
              request.danger ? "bg-warn" : "bg-rb"
            }`}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
