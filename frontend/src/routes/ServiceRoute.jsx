import { Navigate, Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import React from 'react';

export function ServiceRoute() {
  const user = useSelector((state) => state.auth.user);
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'service') {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-red-600">403 - Access denied</h1>
        <p className="mt-2">This area is restricted.</p>
      </div>
    );
  }
  return <Outlet />;
}
