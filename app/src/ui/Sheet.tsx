/** A sheet: a bottom sheet on a phone (the top of the book stays in view), a side panel over the rail on a laptop. */
import { useEffect, useRef } from "react";
import { openSheet, useUi, type SheetId } from "../state/store";
import { CloseIcon } from "./icons";

export function Sheet({ id, title, testid, children, tall, onClose }: { id: SheetId; title: React.ReactNode; testid?: string; children: React.ReactNode; tall?: boolean; onClose?: () => void }) {
  const open = useUi((s) => s.sheet === id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const close = () => {
    onClose?.();
    openSheet(null);
  };
  return (
    <aside className={"sheet" + (tall ? " tall" : "")} data-testid={testid} role="dialog" aria-label={typeof title === "string" ? title : undefined} ref={ref} tabIndex={-1}>
      <div className="grab" aria-hidden="true" />
      <div className="sheet-h">
        <h2>{title}</h2>
        <button className="close" onClick={close} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <div className="sheet-b">{children}</div>
    </aside>
  );
}
