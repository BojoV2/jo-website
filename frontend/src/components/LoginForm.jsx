import { useEffect, useRef, useState } from 'react';
import AuthBackgroundPaths from './AuthBackgroundPaths.jsx';

export default function LoginForm({ onLogin, loading, error = '', theme = 'light', onToggleTheme }) {
  const [identifier, setIdentifier] = useState('superadmin@example.com');
  const [password, setPassword] = useState('SuperAdmin123!');
  const [rememberMe, setRememberMe] = useState(true);
  const [showForgotModal, setShowForgotModal] = useState(false);
  const forgotBtnRef = useRef(null);
  const forgotModalRef = useRef(null);

  useEffect(() => {
    if (!showForgotModal) {
      forgotBtnRef.current?.focus();
      return;
    }
    function onKey(e) { if (e.key === 'Escape') setShowForgotModal(false); }
    window.addEventListener('keydown', onKey);
    const timer = setTimeout(() => forgotModalRef.current?.querySelector('button')?.focus(), 40);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [showForgotModal]);

  const submit = (e) => {
    e.preventDefault();
    onLogin({ identifier, password, rememberMe });
  };

  return (
    <div className="auth-shell">
      <AuthBackgroundPaths theme={theme} />
      <div className="glow" />
      <div className="auth-frame">
        <form className="card auth-card auth-login-card" onSubmit={submit}>
          <div className="auth-toolbar">
            <img
              className="auth-logo"
              src="/imperial-network-logo.svg"
              alt="Imperial Network Incorporated"
            />
            <button
              type="button"
              className="theme-btn"
              onClick={onToggleTheme}
            >
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            </button>
          </div>

          <div className="auth-copy">
            <h1>Welcome back</h1>
            <p className="muted">Sign in to access the Imperial Network workflow portal.</p>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <label htmlFor="login-identifier">Name or Email</label>
          <input
            id="login-identifier"
            name="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="name@example.com"
            autoComplete="username"
            required
          />

          <div className="auth-password-row">
            <label htmlFor="login-password">Password</label>
            <button
              ref={forgotBtnRef}
              type="button"
              className="forgot-link"
              onClick={() => setShowForgotModal(true)}
            >
              Forgot your password?
            </button>
          </div>
          <input
            id="login-password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          <label className="checkbox-line auth-remember" htmlFor="login-remember-me">
            <input
              id="login-remember-me"
              name="remember_me"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Keep me signed in on this device
          </label>

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Login'}
          </button>

          <div className="auth-footnote">
            By continuing, you agree to the portal access and security policy of Imperial Network Incorporated.
          </div>
        </form>

        <aside className="card auth-brand-panel">
          <div className="auth-brand-backdrop" />
          <div className="auth-brand-content">
            <img
              className="auth-brand-logo"
              src="/imperial-network-logo.svg"
              alt="Imperial Network Incorporated"
            />
            <div className="auth-brand-text">
              <span className="auth-brand-kicker">Operations portal</span>
              <h2>Manage templates, generated documents, and reporting in one secure workspace.</h2>
              <p>
                Built for daily processing, template control, analytics visibility, and workflow tracking.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {showForgotModal && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowForgotModal(false)}>
          <div
            className="modal-card"
            ref={forgotModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Forgot password"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              className="forgot-image"
              src="/forgot-password-gorilla.jpg"
              alt="Forgot password"
            />
            <button type="button" onClick={() => setShowForgotModal(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
