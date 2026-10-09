'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminApi, errorMessage, setAdminToken } from '@/lib/api';
import { Button, Card, ErrorBox } from '@/components/ui';

export default function AdminLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminApi.login({ username, password });
      setAdminToken(res.accessToken);
      router.replace('/admin');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h1 className="mb-4 text-xl font-bold">Operator login</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Username
          <input className="rounded-lg border border-slate-300 px-3 py-2 text-base" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Password
          <input
            className="rounded-lg border border-slate-300 px-3 py-2 text-base"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <ErrorBox error={error} />
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}
