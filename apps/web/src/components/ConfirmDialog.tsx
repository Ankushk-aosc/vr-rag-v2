"use client";

import React, { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  theme: "light" | "dark";
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal confirmation with focus trapped inside, Escape to cancel, and focus returned on close. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  theme,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Tab" && panelRef.current) {
        const items = panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, busy, onCancel]);

  if (!open) return null;
  const isLight = theme === "light";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/40" onMouseDown={() => !busy && onCancel()}>
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onMouseDown={(e) => e.stopPropagation()}
        className={`w-full max-w-md rounded-lg border p-5 shadow-xl ${
          isLight ? "bg-white border-slate-200 text-slate-900" : "bg-[#0F172A] border-slate-700 text-slate-100"
        }`}
      >
        <h2 id="confirm-title" className="text-[16px] font-semibold">
          {title}
        </h2>
        <p id="confirm-body" className={`text-[14px] leading-relaxed mt-2 ${isLight ? "text-slate-600" : "text-slate-300"}`}>
          {body}
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`h-9 px-3.5 rounded-md border text-[13px] font-medium ${
              isLight ? "border-slate-300 hover:bg-slate-50" : "border-slate-600 hover:bg-slate-800"
            }`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`h-9 px-3.5 rounded-md text-[13px] font-medium text-white disabled:opacity-60 ${
              destructive ? "bg-rose-600 hover:bg-rose-700" : "bg-[#2563EB] hover:bg-[#1D4ED8]"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
