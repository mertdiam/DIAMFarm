import { useState, useEffect, useCallback } from 'react';
import { authClient } from '../lib/authClient';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

// Admin-only user management. Reached only when the signed-in user is an admin (the App
// guard hides the nav entry and the server enforces admin on every /api/auth admin route).
// Uses the Better Auth admin client (authClient.admin.*): listUsers, createUser, setRole,
// banUser/unbanUser, removeUser. Palette copied from Settings.jsx.
//
// No public sign-up exists: this create form is the only way to add an account after the
// seeded first admin.

const ROLES = ['operator', 'admin'];

const inputStyle = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '8px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  boxSizing: 'border-box',
};

const primaryBtn = {
  background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6,
  padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

export default function Users() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('operator');
  const [creating, setCreating] = useState(false);
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const load = useCallback(async () => {
    const res = await authClient.admin.listUsers({ query: { limit: 200, sortBy: 'createdAt' } });
    if (res.error) {
      showToast('Load users failed: ' + (res.error.message || res.error.status), 'error');
      setLoading(false);
      return;
    }
    // The admin plugin returns { data: { users: [...] } }; tolerate a bare array too.
    const list = Array.isArray(res.data) ? res.data : (res.data?.users || []);
    setUsers(list);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    const res = await authClient.admin.createUser({ email, password, name, role });
    setCreating(false);
    if (res.error) {
      showToast('Create failed: ' + (res.error.message || res.error.status), 'error');
      return;
    }
    showToast('User created', 'success');
    setEmail(''); setName(''); setPassword(''); setRole('operator');
    load();
  }

  async function handleSetRole(user, newRole) {
    if (newRole === user.role) return;
    const res = await authClient.admin.setRole({ userId: user.id, role: newRole });
    if (res.error) {
      showToast('Set role failed: ' + (res.error.message || res.error.status), 'error');
      load(); // resync the select to the real value
      return;
    }
    showToast(`Role updated to ${newRole}`, 'success');
    load();
  }

  async function handleToggleBan(user) {
    if (user.banned) {
      const res = await authClient.admin.unbanUser({ userId: user.id });
      if (res.error) return showToast('Unban failed: ' + (res.error.message || res.error.status), 'error');
      showToast('User unbanned', 'success');
      return load();
    }
    const ok = await confirm({
      title: 'Ban user',
      message: `Ban ${user.email}? They will be signed out and blocked from logging in until unbanned.`,
      confirmLabel: 'Ban',
      danger: true,
    });
    if (!ok) return;
    const res = await authClient.admin.banUser({ userId: user.id });
    if (res.error) return showToast('Ban failed: ' + (res.error.message || res.error.status), 'error');
    showToast('User banned', 'warning');
    load();
  }

  async function handleRemove(user) {
    const ok = await confirm({
      title: 'Remove user',
      message: `Permanently remove ${user.email}? This deletes their account and cannot be undone.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const res = await authClient.admin.removeUser({ userId: user.id });
    if (res.error) return showToast('Remove failed: ' + (res.error.message || res.error.status), 'error');
    showToast('User removed', 'success');
    load();
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: '#e2e8f0', marginBottom: 20 }}>Users</h1>

      {/* Create user */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 14 }}>Create user</div>
        <form onSubmit={handleCreate} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Name</label>
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Password</label>
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div style={{ flex: '0 1 120px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#64748b', marginBottom: 4 }}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button type="submit" disabled={creating} style={{ ...primaryBtn, opacity: creating ? 0.7 : 1, cursor: creating ? 'not-allowed' : 'pointer' }}>
            {creating ? 'Creating...' : 'Create'}
          </button>
        </form>
      </section>

      {/* User list */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, maxWidth: 760 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 14 }}>Accounts</div>
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>Loading...</div>
        ) : users.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>No users.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
              <thead>
                <tr style={{ color: '#64748b', textAlign: 'left', borderBottom: '1px solid #334155' }}>
                  <th style={{ padding: '6px 8px' }}>Email</th>
                  <th style={{ padding: '6px 8px' }}>Name</th>
                  <th style={{ padding: '6px 8px' }}>Role</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #1a2030' }}>
                    <td style={{ padding: '8px', color: '#e2e8f0' }}>{u.email}</td>
                    <td style={{ padding: '8px', color: '#94a3b8' }}>{u.name}</td>
                    <td style={{ padding: '8px' }}>
                      <select
                        value={(u.role || 'operator').split(',')[0]}
                        onChange={(e) => handleSetRole(u, e.target.value)}
                        style={{ ...inputStyle, padding: '4px 8px' }}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '8px', color: u.banned ? '#f87171' : '#4ade80' }}>
                      {u.banned ? 'Banned' : 'Active'}
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => handleToggleBan(u)}
                        style={{ background: 'none', border: '1px solid #78350f', borderRadius: 4, color: '#fbbf24', fontSize: 12, padding: '3px 10px', cursor: 'pointer', marginRight: 6 }}
                      >
                        {u.banned ? 'Unban' : 'Ban'}
                      </button>
                      <button
                        onClick={() => handleRemove(u)}
                        style={{ background: 'none', border: '1px solid #7f1d1d', borderRadius: 4, color: '#f87171', fontSize: 12, padding: '3px 10px', cursor: 'pointer' }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {toastEl}
      {confirmModal}
    </div>
  );
}
