import { useState } from 'react';

export default function LoginForm({ onLogin, loading }) {
  const [identifier, setIdentifier] = useState('superadmin@example.com');
  const [password, setPassword] = useState('SuperAdmin123!');
  const [rememberMe, setRememberMe] = useState(true);

  const submit = (e) => {
    e.preventDefault();
    onLogin({ identifier, password, rememberMe });
  };

  return (
    <div className="auth-shell">
      <div className="glow" />
      <form className="card auth-card" onSubmit={submit}>
        <h1>PDF Workflow</h1>
        <p className="muted">Sign in to manage templates, fields, and generated documents.</p>

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

        <button type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Login'}</button>
      </form>
    </div>
  );
}
