'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearAdminToken, getAdminToken } from '@/lib/api';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/liquids', label: 'Liquids & pumps' },
  { href: '/admin/calibration', label: 'Calibration' },
  { href: '/admin/events', label: 'Events' },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname?.startsWith('/admin/login') ?? false;
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    if (isLogin) return;
    if (getAdminToken()) setAuthed(true);
    else router.replace('/admin/login');
  }, [isLogin, router]);

  if (isLogin) return <main className="mx-auto max-w-sm px-4 py-10">{children}</main>;
  if (!authed) return null;

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-2">
          <span className="mr-3 font-bold">PegPal Admin</span>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${pathname === n.href ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
            >
              {n.label}
            </Link>
          ))}
          <button
            type="button"
            className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            onClick={() => {
              clearAdminToken();
              router.replace('/admin/login');
            }}
          >
            Log out
          </button>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
    </div>
  );
}
