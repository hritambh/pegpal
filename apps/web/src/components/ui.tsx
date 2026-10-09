'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '@/lib/labels';
import { clampPercent } from '@/lib/progress';

const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-green-100 text-green-800 ring-green-600/20',
  amber: 'bg-amber-100 text-amber-900 ring-amber-600/20',
  red: 'bg-red-100 text-red-800 ring-red-600/20',
  grey: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  blue: 'bg-blue-100 text-blue-800 ring-blue-600/20',
};

export function Badge({ tone, children, large }: { tone: Tone; children: ReactNode; large?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ring-1 ring-inset ${TONE_BADGE[tone]} ${
        large ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {children}
    </span>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500',
  secondary: 'bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300 disabled:text-slate-500',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'min-h-9 px-3 text-sm', md: 'min-h-11 px-4 text-base', lg: 'min-h-14 px-6 text-lg w-full' };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center rounded-xl font-semibold transition disabled:cursor-not-allowed ${sizes[size]} ${VARIANT[variant]} ${className}`}
    />
  );
}

const TONE_BANNER: Record<Tone, string> = {
  green: 'border-green-300 bg-green-50 text-green-900',
  amber: 'border-amber-400 bg-amber-50 text-amber-900',
  red: 'border-red-300 bg-red-50 text-red-900',
  grey: 'border-slate-300 bg-slate-50 text-slate-800',
  blue: 'border-blue-300 bg-blue-50 text-blue-900',
};

export function Banner({ tone, title, children }: { tone: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={`rounded-xl border-2 px-4 py-3 ${TONE_BANNER[tone]}`}>
      {title && <p className="font-bold">{title}</p>}
      {children && <div className="text-sm">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <Banner tone="red">{error}</Banner>;
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  const p = clampPercent(percent);
  return (
    <div
      className="h-4 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-label={label}
    >
      <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${p}%` }} />
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-slate-500" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      {label}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${className}`}>{children}</section>;
}
