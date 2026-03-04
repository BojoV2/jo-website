import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../api.js';
import { fallbackAvatarUrl, resolveAvatar } from '../utils/avatar.js';

function toLocalTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString();
}

export default function ProfileSidebar({
  open,
  onClose,
  token,
  user,
  onUserUpdated
}) {
  const [profileForm, setProfileForm] = useState({
    name: user?.name || '',
    email: user?.email || '',
    avatar_url: user?.avatar_url || ''
  });
  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm_password: ''
  });
  const [activeUsers, setActiveUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const avatarChoices = useMemo(() => {
    const seed = String(profileForm.name || user?.name || 'User').trim() || 'User';
    return [
      fallbackAvatarUrl(seed),
      fallbackAvatarUrl(`${seed}-a`),
      fallbackAvatarUrl(`${seed}-b`),
      fallbackAvatarUrl(`${seed}-c`),
      fallbackAvatarUrl(`${seed}-d`)
    ];
  }, [profileForm.name, user?.name]);

  useEffect(() => {
    if (!open) return;
    setProfileForm({
      name: user?.name || '',
      email: user?.email || '',
      avatar_url: user?.avatar_url || ''
    });
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadSidebarData() {
      try {
        const [meData, activeData] = await Promise.all([
          apiRequest('/auth/me', { token }),
          apiRequest('/auth/active-users', { token })
        ]);

        if (cancelled) return;

        if (meData?.user) {
          setProfileForm({
            name: meData.user.name || '',
            email: meData.user.email || '',
            avatar_url: meData.user.avatar_url || ''
          });
          if (onUserUpdated) {
            onUserUpdated(meData.user);
          }
        }

        setActiveUsers(Array.isArray(activeData) ? activeData : []);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      }
    }

    loadSidebarData();
    const timer = setInterval(loadSidebarData, 30000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, token, onUserUpdated]);

  async function saveProfile(e) {
    e.preventDefault();
    setSavingProfile(true);
    setError('');
    setMessage('');
    try {
      const payload = {
        name: profileForm.name,
        email: profileForm.email,
        avatar_url: profileForm.avatar_url
      };
      const data = await apiRequest('/auth/me', {
        method: 'PATCH',
        token,
        body: payload
      });
      if (data?.user && onUserUpdated) {
        onUserUpdated(data.user);
      }
      setMessage('Profile updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setSavingPassword(true);
    setError('');
    setMessage('');
    try {
      if (passwordForm.new_password !== passwordForm.confirm_password) {
        throw new Error('New password and confirm password must match');
      }
      await apiRequest('/auth/me/password', {
        method: 'PATCH',
        token,
        body: {
          current_password: passwordForm.current_password,
          new_password: passwordForm.new_password
        }
      });
      setPasswordForm({
        current_password: '',
        new_password: '',
        confirm_password: ''
      });
      setMessage('Password updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={open ? 'sidebar-backdrop open' : 'sidebar-backdrop'}
        onClick={onClose}
        aria-label="Close sidebar"
      />
      <aside className={open ? 'profile-sidebar open' : 'profile-sidebar'} aria-hidden={!open}>
        <div className="sidebar-head">
          <div className="profile-head">
            <img className="avatar avatar-md" src={resolveAvatar(user)} alt={user?.name || 'User'} />
            <div>
              <h3>{user?.name || 'User'}</h3>
              <p className="muted">{user?.role || 'user'}</p>
            </div>
          </div>
          <button type="button" className="sidebar-close" onClick={onClose}>Close</button>
        </div>

        <div className="sidebar-section">
          <h4>Active Users</h4>
          <div className="active-user-list">
            {activeUsers.map((active) => (
              <div key={active.id} className="active-user-item">
                <span className="active-dot" />
                <img className="avatar avatar-sm" src={resolveAvatar(active)} alt={active.name} />
                <div className="active-user-meta">
                  <strong>{active.name}</strong>
                  <span>{active.role}</span>
                </div>
                <span className="active-time">{toLocalTime(active.last_active_at)}</span>
              </div>
            ))}
            {activeUsers.length === 0 && (
              <p className="muted">No active users right now.</p>
            )}
          </div>
        </div>

        <div className="sidebar-section sidebar-settings">
          <h4>Settings</h4>
          {error && <div className="notice is-error">{error}</div>}
          {message && <div className="notice is-success">{message}</div>}

          <form onSubmit={saveProfile} className="sidebar-form">
            <label>Name</label>
            <input
              value={profileForm.name}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
            <label>Email</label>
            <input
              type="email"
              value={profileForm.email}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, email: e.target.value }))}
              required
            />
            <label>Avatar URL (optional)</label>
            <input
              value={profileForm.avatar_url}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, avatar_url: e.target.value }))}
              placeholder="https://..."
            />
            <div className="avatar-picker">
              {avatarChoices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="avatar-choice"
                  onClick={() => setProfileForm((prev) => ({ ...prev, avatar_url: choice }))}
                  title="Use this avatar"
                >
                  <img className="avatar avatar-sm" src={choice} alt="Avatar choice" />
                </button>
              ))}
            </div>
            <button disabled={savingProfile}>{savingProfile ? 'Saving...' : 'Save Profile'}</button>
          </form>

          <form onSubmit={savePassword} className="sidebar-form">
            <label>Current Password</label>
            <input
              type="password"
              value={passwordForm.current_password}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, current_password: e.target.value }))}
              required
            />
            <label>New Password</label>
            <input
              type="password"
              value={passwordForm.new_password}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, new_password: e.target.value }))}
              required
              minLength={6}
            />
            <label>Confirm New Password</label>
            <input
              type="password"
              value={passwordForm.confirm_password}
              onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirm_password: e.target.value }))}
              required
              minLength={6}
            />
            <button disabled={savingPassword}>{savingPassword ? 'Saving...' : 'Change Password'}</button>
          </form>
        </div>
      </aside>
    </>
  );
}
