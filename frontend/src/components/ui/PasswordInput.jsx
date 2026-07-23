import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState } from 'react';
import { Input } from './Input';

export const PasswordInput = forwardRef(function PasswordInput({ visibleLabel = "Ko'rish", hiddenLabel = 'Yashirish', ...props }, ref) {
  const [visible, setVisible] = useState(false);

  return (
    <Input
      ref={ref}
      {...props}
      type={visible ? 'text' : 'password'}
      rightElement={
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-rose-300/40"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? hiddenLabel : visibleLabel}
          title={visible ? hiddenLabel : visibleLabel}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      }
    />
  );
});
