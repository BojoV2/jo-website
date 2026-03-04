import { useEffect, useMemo, useState } from 'react';
import { apiRequest, getApiBase } from './api.js';
import LoginForm from './components/LoginForm.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import UserPanel from './components/UserPanel.jsx';

function readSession() {
  const raw = localStorage.getItem('pdfwf.session') || sessionStorage.getItem('pdfwf.session');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function readTheme() {
  const value = localStorage.getItem('pdfwf.theme');
  return value === 'dark' ? 'dark' : 'light';
}

export default function App() {
  const [session, setSession] = useState(readSession());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(readTheme());

  const apiBase = useMemo(() => getApiBase(), []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pdfwf.theme', theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  function storeSession(nextSession, mode = 'auto') {
    const hasLocal = Boolean(localStorage.getItem('pdfwf.session'));
    const target = mode === 'local'
      ? 'local'
      : mode === 'session'
        ? 'session'
        : hasLocal
          ? 'local'
          : 'session';

    sessionStorage.removeItem('pdfwf.session');
    localStorage.removeItem('pdfwf.session');
    if (target === 'local') {
      localStorage.setItem('pdfwf.session', JSON.stringify(nextSession));
    } else {
      sessionStorage.setItem('pdfwf.session', JSON.stringify(nextSession));
    }
  }

  async function handleLogin(credentials) {
    setLoading(true);
    setError('');
    try {
      const { identifier, password, rememberMe } = credentials;
      const data = await apiRequest('/auth/login', {
        method: 'POST',
        body: { identifier, password, remember_me: Boolean(rememberMe) }
      });

      const next = { token: data.token, user: data.user };
      storeSession(next, rememberMe ? 'local' : 'session');
      setSession(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    sessionStorage.removeItem('pdfwf.session');
    localStorage.removeItem('pdfwf.session');
    setSession(null);
  }

  function handleSessionUserUpdate(nextUser) {
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, user: { ...prev.user, ...nextUser } };
      storeSession(next, 'auto');
      return next;
    });
  }

  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    apiRequest('/auth/me', { token: session.token })
      .then((data) => {
        if (cancelled || !data?.user) return;
        handleSessionUserUpdate(data.user);
      })
      .catch(() => {
        if (!cancelled) {
          logout();
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  if (!session) {
    return (
      <>
        <LoginForm
          onLogin={handleLogin}
          loading={loading}
          error={error}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <div className="meta">API: {apiBase}</div>
      </>
    );
  }

  const sharedProps = {
    token: session.token,
    user: session.user,
    onLogout: logout,
    theme,
    onToggleTheme: toggleTheme,
    onSessionUserUpdate: handleSessionUserUpdate
  };

  if (session.user.role === 'super_admin' || session.user.role === 'admin') {
    return <AdminPanel {...sharedProps} />;
  }

  return <UserPanel {...sharedProps} />;
}
