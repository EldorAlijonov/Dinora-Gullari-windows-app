import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Outlet, useLocation } from 'react-router-dom';
import { api } from '../../services/api';
import { GlobalLoadingIndicator } from './GlobalLoadingIndicator';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

const configuredRefreshInterval = Number(import.meta.env.VITE_AUTO_REFRESH_MS);
const AUTO_REFRESH_INTERVAL_MS =
  Number.isFinite(configuredRefreshInterval) && configuredRefreshInterval >= 5_000 ? configuredRefreshInterval : 10_000;
const AUTO_REFRESH_TAGS = ['Orders', 'Sales', 'Debts', 'Dashboard', 'Reports', 'Notifications', 'Backups'];

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const dispatch = useDispatch();

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', String(collapsed));
  }, [collapsed]);

  useEffect(() => {
    const refreshActiveQueries = () => {
      dispatch(api.util.invalidateTags(AUTO_REFRESH_TAGS));
    };

    const intervalId = window.setInterval(refreshActiveQueries, AUTO_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshActiveQueries();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [dispatch]);

  return (
    <div className="flex min-h-screen bg-transparent text-slate-100">
      <GlobalLoadingIndicator />
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="min-w-0 flex-1">
        <Topbar collapsed={collapsed} onToggleSidebar={() => setCollapsed((value) => !value)} onOpenMobile={() => setMobileOpen(true)} />
        <motion.main
          key={location.pathname}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="mx-auto max-w-[1430px] px-4 py-5 lg:px-6"
        >
          <Outlet />
        </motion.main>
      </div>
    </div>
  );
}
