import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';

export function ProtectedRoute() {
  const user = useSelector((state) => state.auth.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace />;

  if (user.role === 'service' && !location.pathname.startsWith('/service')) {
    return <Navigate to="/service" replace />;
  }

  if (Number(user.mustChangePassword) === 1 && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  if (user.role === 'admin' && location.pathname === '/login') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
