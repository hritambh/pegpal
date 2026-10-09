'use client';

import { useEffect, useState } from 'react';
import type { AdminMachineView, MockFaultConfig } from '@pegpal/shared';
import { adminApi, errorMessage } from '@/lib/api';
import { usePolling } from '@/hooks/usePolling';
import { Badge, Button, Card, ErrorBox } from '../ui';
import { inputClass } from './MachineSelect';

/** Parses a "1:0.5, 3:1.2" string into channel multipliers. Returns null on bad input. */
function parseChannelMultipliers(text: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [ch, mult] = part.split(':').map((s) => s.trim());
    const n = Number(mult);
    if (!/^\d+$/.test(ch ?? '') || !Number.isFinite(n) || n <= 0) return null;
    out[ch] = n;
  }
  return out;
}

const optNum = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function MockPanel({ machine }: { machine: AdminMachineView }) {
  const { data: state, error: loadError, reload, setData } = usePolling(() => adminApi.mockState(machine.id), 3000, [machine.id]);
  const [form, setForm] = useState<MockFaultConfig | null>(null);
  const [multText, setMultText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (state && !dirty) {
      setForm(state.config);
      setMultText(Object.entries(state.config.channelFlowMultipliers ?? {}).map(([k, v]) => `${k}:${v}`).join(', '));
    }
  }, [state, dirty]);

  const act = async (fn: () => Promise<typeof state>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (s) setData(s);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const edit = (patch: Partial<MockFaultConfig>) => {
    setDirty(true);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const save = () => {
    if (!form) return;
    const mults = parseChannelMultipliers(multText);
    if (!mults) {
      setError('Channel multipliers must look like "0:0.8, 3:1.2"');
      return;
    }
    const fractions = [form.disconnectAtFraction, form.estopAtFraction];
    if (fractions.some((f) => f !== null && (!Number.isFinite(f) || f < 0 || f > 1))) {
      setError('Fractions must be between 0 and 1');
      return;
    }
    void act(async () => {
      const s = await adminApi.mockConfig(machine.id, { ...form, channelFlowMultipliers: mults });
      setDirty(false);
      return s;
    });
  };

  return (
    <Card className="flex flex-col gap-3 border-2 border-dashed border-amber-400">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold">Simulator — {machine.name}</h3>
        <Badge tone="amber">MOCK</Badge>
      </div>
      <ErrorBox error={loadError} />
      {state && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={state.connected ? 'green' : 'red'}>{state.connected ? 'Connected' : 'Disconnected'}</Badge>
            <Badge tone={state.estopActive ? 'red' : 'green'}>{state.estopActive ? 'Sim e-stop PRESSED' : 'Sim e-stop released'}</Badge>
            {state.activeCommandId && <span className="font-mono text-xs">cmd {state.activeCommandId}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => adminApi.mockConnection(machine.id, !state.connected))}>
              {state.connected ? 'Disconnect' : 'Reconnect'}
            </Button>
            <Button size="sm" variant={state.estopActive ? 'secondary' : 'danger'} disabled={busy} onClick={() => void act(() => adminApi.mockEstop(machine.id, !state.estopActive))}>
              {state.estopActive ? 'Release simulated e-stop' : 'Press simulated e-stop'}
            </Button>
          </div>
        </>
      )}
      {form && (
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            Flow rate multiplier
            <input className={inputClass} type="number" step="0.05" min="0.01" value={form.flowRateMultiplier} onChange={(e) => edit({ flowRateMultiplier: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">
            Per-channel multipliers (ch:mult, …)
            <input
              className={inputClass}
              value={multText}
              placeholder="0:0.8, 3:1.2"
              onChange={(e) => {
                setDirty(true);
                setMultText(e.target.value);
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            Fail channel (blank = none)
            <input className={inputClass} type="number" min="0" max="9" value={form.failChannel ?? ''} onChange={(e) => edit({ failChannel: optNum(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">
            Disconnect at fraction (0-1, blank = never)
            <input className={inputClass} type="number" step="0.05" min="0" max="1" value={form.disconnectAtFraction ?? ''} onChange={(e) => edit({ disconnectAtFraction: optNum(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">
            E-stop at fraction (0-1, blank = never)
            <input className={inputClass} type="number" step="0.05" min="0" max="1" value={form.estopAtFraction ?? ''} onChange={(e) => edit({ estopAtFraction: optNum(e.target.value) })} />
          </label>
          <div className="flex flex-col gap-2">
            {(
              [
                ['dropAcks', 'Drop ACKs'],
                ['dropCompletion', 'Never send DONE'],
                ['scaleUnstable', 'Scale unstable'],
                ['scaleMissing', 'Scale missing'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={form[key]} onChange={(e) => edit({ [key]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
      {form && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !dirty} onClick={save}>
            Save fault config
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !dirty}
            onClick={() => {
              setDirty(false);
              void reload();
            }}
          >
            Discard
          </Button>
        </div>
      )}
    </Card>
  );
}
