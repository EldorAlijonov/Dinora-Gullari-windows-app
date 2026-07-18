import { createSlice } from '@reduxjs/toolkit';

const storedUser = localStorage.getItem('user');
const token = localStorage.getItem('token');
const user = import.meta.env.VITE_DESKTOP === 'true' && !token ? null : storedUser;

if (import.meta.env.VITE_DESKTOP === 'true' && storedUser && !token) {
  localStorage.removeItem('user');
}

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user: user ? JSON.parse(user) : null,
    token,
  },
  reducers: {
    setCredentials: (state, action) => {
      state.user = action.payload.user;
      state.token = action.payload.accessToken || null;
      localStorage.setItem('user', JSON.stringify(action.payload.user));
      if (action.payload.accessToken) {
        localStorage.setItem('token', action.payload.accessToken);
      } else {
        localStorage.removeItem('token');
      }
    },
    updateUser: (state, action) => {
      state.user = { ...state.user, ...action.payload };
      localStorage.setItem('user', JSON.stringify(state.user));
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      localStorage.removeItem('user');
      localStorage.removeItem('token');
    },
  },
});

export const { setCredentials, updateUser, logout } = authSlice.actions;
export default authSlice.reducer;
