'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the dialog asks for a text value (e.g. a reason) and passes it to onConfirm. */
  inputLabel?: string;
  inputDefault?: string;
  inputRequired?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, onCancel } = props;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl p-0 backdrop:bg-black/50"
    >
      {open && <DialogBody {...props} />}
    </dialog>
  );
}

function DialogBody({ title, message, confirmLabel, danger, inputLabel, inputDefault, inputRequired, onConfirm, onCancel }: ConfirmDialogProps) {
  const [value, setValue] = useState(inputDefault ?? '');
  const blocked = Boolean(inputLabel && inputRequired && !value.trim());
  return (
    <form
      method="dialog"
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onConfirm(value.trim());
      }}
    >
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="text-slate-700">{message}</p>
      {inputLabel && (
        <label className="flex flex-col gap-1 text-sm font-medium">
          {inputLabel}
          <input
            className="rounded-lg border border-slate-300 px-3 py-2 text-base"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={500}
            autoFocus
          />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={blocked}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
