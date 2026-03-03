import { useState } from 'react';

export default function LoginForm({ onLogin, loading, error = '', theme = 'light', onToggleTheme }) {
  const [identifier, setIdentifier] = useState('superadmin@example.com');
  const [password, setPassword] = useState('SuperAdmin123!');
  const [rememberMe, setRememberMe] = useState(true);
  const [showForgotModal, setShowForgotModal] = useState(false);

  const submit = (e) => {
    e.preventDefault();
    onLogin({ identifier, password, rememberMe });
  };

  return (
    <div className="auth-shell">
      <div className="glow" />
      <form className="card auth-card" onSubmit={submit}>
        <div className="topbar-actions">
          <button
            type="button"
            className="theme-btn"
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>
        <h1>PDF Workflow</h1>
        <p className="muted">Sign in to manage templates, fields, and generated documents.</p>
        {error && <div className="auth-error">{error}</div>}

        <label>Name or Email</label>
        <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />

        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          Remember me
        </label>
        <button
          type="button"
          className="forgot-link"
          onClick={() => setShowForgotModal(true)}
        >
          Forgot password?
        </button>

        <button type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Login'}</button>
      </form>

      {showForgotModal && (
        <div className="modal-backdrop" onClick={() => setShowForgotModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
