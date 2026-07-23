import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { PasswordInput } from '../components/ui/PasswordInput';
import { updateUser } from '../features/auth/authSlice';
import { useChangePasswordMutation } from '../services/api';

export default function ChangePasswordPage() {
  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth.user);
  const [changePassword, { isLoading }] = useChangePasswordMutation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const navigate = useNavigate();

  const submit = async () => {
    if (next.length < 6) {
      toast.error('Yangi parol kamida 6 ta belgidan iborat bo‘lishi kerak');
      return;
    }
    if (next !== confirm) {
      toast.error('Yangi parollar mos emas');
      return;
    }
    await changePassword({ currentPassword: current, newPassword: next }).unwrap();
    dispatch(updateUser({ mustChangePassword: 0 }));
    toast.success('Parol yangilandi');
    navigate(user?.role === 'service' ? '/service' : '/', { replace: true });
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-white/8 p-6 shadow-panel">
        <p className="text-sm font-bold uppercase text-rose-300">Xavfsizlik</p>
        <h1 className="mt-1 text-2xl font-bold">Parolni almashtirish</h1>
        <div className="mt-5 space-y-4">
          <PasswordInput label="Joriy parol" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <PasswordInput label="Yangi parol" value={next} onChange={(e) => setNext(e.target.value)} />
          <PasswordInput label="Yangi parolni takrorlang" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button loading={isLoading} className="w-full" onClick={submit}>Parolni almashtirish</Button>
        </div>
      </div>
    </div>
  );
}
