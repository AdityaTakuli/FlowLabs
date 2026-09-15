import { useEffect, useRef } from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{request.title}</h2>
        <p>{request.message}</p>
        <div className="button-row end">
          <button ref={cancel} onClick={onClose}>
            Cancel
          </button>
          <button
            className={request.danger ? "danger" : "primary"}
            onClick={() => {
              onClose();
              request.onConfirm();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
