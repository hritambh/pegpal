'use client';

import { useState } from 'react';
import type { AdminLiquidView } from '@pegpal/shared';
import { adminApi, errorMessage } from '@/lib/api';
import { EMPTY_LIQUID_FORM, liquidToForm, parseLiquidForm, type LiquidFormValues } from '@/lib/liquidForm';
import { Button, Card, ErrorBox } from '../ui';
import { inputClass } from './MachineSelect';

interface Props {
  machineId: string;
  editing: AdminLiquidView | null;
  onSaved: () => void;
  onClose: () => void;
}

export function LiquidForm({ machineId, editing, onSaved, onClose }: Props) {
  const [v, setV] = useState<LiquidFormValues>(editing ? liquidToForm(editing) : EMPTY_LIQUID_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof LiquidFormValues>(k: K, val: LiquidFormValues[K]) => setV((cur) => ({ ...cur, [k]: val }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseLiquidForm(v);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setBusy(true);
    setError(null);
    try {
      if (editing) await adminApi.updateLiquid(editing.id, parsed.body);
      else await adminApi.createLiquid(machineId, parsed.body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: Exclude<keyof LiquidFormValues, 'active' | 'strategy'>, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input className={inputClass} value={v[key]} onChange={(e) => set(key, e.target.value)} {...props} />
    </label>
  );

  return (
    <Card>
      <h2 className="mb-3 text-lg font-bold">{editing ? `Edit ${editing.name}` : 'Add liquid'}</h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {field('Name', 'name', { required: true, maxLength: 100 })}
          {field('Pump channel (0-9)', 'pumpChannel', { inputMode: 'numeric' })}
          <label className="flex flex-col gap-1 text-sm font-medium">
            Strategy
            <select className={inputClass} value={v.strategy} onChange={(e) => set('strategy', e.target.value as LiquidFormValues['strategy'])}>
              <option value="TIMED">TIMED (pump runtime)</option>
              <option value="WEIGHT">WEIGHT (load cell)</option>
            </select>
          </label>
          {field('Density (g/mL)', 'densityGPerMl', { inputMode: 'decimal', placeholder: 'e.g. 0.95' })}
          {field('Cutoff margin (g)', 'cutoffMarginG', { inputMode: 'decimal' })}
          {field('Price per mL', 'pricePerMl', { inputMode: 'decimal' })}
          {field('Min mL', 'minMl', { inputMode: 'numeric' })}
          {field('Max mL', 'maxMl', { inputMode: 'numeric' })}
          {field('Remaining stock (mL, blank = untracked)', 'remainingStockMl', { inputMode: 'numeric' })}
          {field('Image URL (optional)', 'imageUrl')}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="h-5 w-5" checked={v.active} onChange={(e) => set('active', e.target.checked)} />
            Active
          </label>
        </div>
        <p className="text-xs text-slate-500">Flow rate is set by calibration, not here.</p>
        {errors.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-red-700">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create liquid'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
