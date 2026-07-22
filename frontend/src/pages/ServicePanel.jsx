import { DatabaseBackup, Download, HardDrive, KeyRound, LogOut, MonitorCog, Upload, UserCog } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { logout } from '../features/auth/authSlice';
import apiClient, { useLogoutMutation } from '../services/api';

function formatBytes(value = 0) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/10 py-3 last:border-b-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="max-w-[62%] break-words text-right text-sm font-semibold text-slate-100">{value || 'unknown'}</span>
    </div>
  );
}

export default function ServicePanel() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector((state) => state.auth.user);
  const fileInputRef = useRef(null);
  const [logoutRequest] = useLogoutMutation();
  const [info, setInfo] = useState(null);
  const [isSavingCustomer, setIsSavingCustomer] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [form, setForm] = useState({ fullName: '', username: '', password: '', confirmPassword: '' });
  const [resetPassword, setResetPassword] = useState('');

  const systemRows = useMemo(
    () => [
      ['Application Version', info?.appVersion],
      ['Database Location', info?.databasePath],
      ['SQLite Size', formatBytes(info?.sqliteSize ?? info?.databaseSize)],
      ['Build Version', info?.buildVersion],
      ['Electron Version', info?.electronVersion || 'not detected'],
    ],
    [info],
  );

  const loadInfo = async () => {
    const response = await apiClient.get('/service/info');
    setInfo(response.data);
  };

  useEffect(() => {
    loadInfo().catch(() => toast.error('Service maвЂ™lumotlarini olishda xatolik'));
  }, []);

  const handleLogout = async () => {
    try {
      await logoutRequest().unwrap();
    } catch {
      // Local logout is enough if the API is temporarily unavailable.
    }
    dispatch(logout());
    navigate('/login', { replace: true });
  };

  const createOrUpdate = async (event) => {
    event.preventDefault();
    if (!form.fullName.trim() || !form.username.trim() || form.password.length < 6) {
      toast.error('Customer name, username va kamida 6 belgili parol kerak');
      return;
    }
    if (form.password !== form.confirmPassword) {
      toast.error('Parollar mos emas');
      return;
    }

    setIsSavingCustomer(true);
    try {
      await apiClient.post('/service/customer', form);
      setForm((current) => ({ ...current, password: '', confirmPassword: '' }));
      toast.success('Customer account yaratildi yoki yangilandi');
    } finally {
      setIsSavingCustomer(false);
    }
  };

  const reset = async (event) => {
    event.preventDefault();
    if (resetPassword.length < 6) {
      toast.error('Yangi parol kamida 6 ta belgi boвЂlishi kerak');
      return;
    }

    setIsResetting(true);
    try {
      await apiClient.post('/service/customer/reset-password', { newPassword: resetPassword });
      setResetPassword('');
      toast.success('Customer paroli yangilandi');
    } finally {
      setIsResetting(false);
    }
  };

  const exportDb = async () => {
    setIsExporting(true);
    try {
      const response = await apiClient.get('/service/backup/export', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `dinora-database-${new Date().toISOString().slice(0, 10)}.sqlite`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Database export qilindi');
    } finally {
      setIsExporting(false);
    }
  };

  const importDb = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const payload = new FormData();
    payload.append('file', file);
    setIsImporting(true);
    try {
      await apiClient.post('/service/backup/import', payload, { headers: { 'Content-Type': 'multipart/form-data' } });
      await loadInfo();
      toast.success('Database import qilindi');
    } finally {
      setIsImporting(false);
      event.target.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 bg-slate-950/90 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-rose-300">Developer Maintenance</p>
            <h1 className="mt-1 text-2xl font-bold">Service Panel</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold">{user?.username || user?.fullName}</p>
              <p className="text-xs text-slate-500">service</p>
            </div>
            <Button variant="secondary" onClick={handleLogout} title="Chiqish">
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-2">
        <form onSubmit={createOrUpdate} className="rounded-lg border border-white/10 bg-white/8 p-5 shadow-panel">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-rose-500/15 text-rose-200">
              <UserCog className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold">Customer Account</h2>
              <p className="text-sm text-slate-500">Create or update the shop owner login.</p>
            </div>
          </div>
          <div className="mt-5 grid gap-4">
            <Input label="Customer name" placeholder="Customer name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            <Input label="Username" placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            <Input label="Password" type="password" placeholder="Password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <Input
              label="Confirm password"
              type="password"
              placeholder="Confirm password"
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
            />
            <Button loading={isSavingCustomer} className="w-full" type="submit">
              <UserCog className="h-4 w-4" />
              Create / Update Customer Account
            </Button>
          </div>
        </form>

        <form onSubmit={reset} className="rounded-lg border border-white/10 bg-white/8 p-5 shadow-panel">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold">Reset Customer Password</h2>
              <p className="text-sm text-slate-500">Force password change on next customer login.</p>
            </div>
          </div>
          <div className="mt-5 grid gap-4">
            <Input
              label="New Password"
              type="password"
              placeholder="New Password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
            <Button loading={isResetting} className="w-full" type="submit">
              <KeyRound className="h-4 w-4" />
              Reset Password
            </Button>
          </div>
        </form>

        <section className="rounded-lg border border-white/10 bg-white/8 p-5 shadow-panel">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-sky-500/15 text-sky-200">
              <MonitorCog className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold">System Information</h2>
              <p className="text-sm text-slate-500">Runtime and database diagnostics.</p>
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-white/10 bg-slate-950/60 px-4">
            {systemRows.map(([label, value]) => <InfoRow key={label} label={label} value={value} />)}
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/8 p-5 shadow-panel">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-500/15 text-emerald-200">
              <DatabaseBackup className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-bold">Backup</h2>
              <p className="text-sm text-slate-500">Export or replace the local SQLite database.</p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Button loading={isExporting} onClick={exportDb} type="button">
              <Download className="h-4 w-4" />
              Export Database
            </Button>
            <Button loading={isImporting} variant="secondary" onClick={() => fileInputRef.current?.click()} type="button">
              <Upload className="h-4 w-4" />
              Import Database
            </Button>
            <input ref={fileInputRef} type="file" className="hidden" accept=".sqlite,.db,.database,application/octet-stream" onChange={importDb} />
          </div>
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-400">
            <HardDrive className="h-4 w-4 text-rose-300" />
            Imported databases are migrated automatically when loaded.
          </div>
        </section>
      </main>
    </div>
  );
}
