import { useState } from 'react';
import { signIn } from '../lib/authClient';
import { useToast } from '../useToast';

// Standalone login screen. Rendered by the App guard whenever there is no session, so it
// draws its own full-page centered layout rather than living inside the nav shell. Palette
// copied from the app's dark theme (page #0a0f1a, card #131720, borders #334155, action
// blue #2563eb). Works at the 600px breakpoint: the card is max-width capped and the page
// padding keeps it off the edges on narrow screens.
//
// There is no sign-up form on purpose: public sign-up is disabled server-side, so accounts
// are created by an admin from the Users page.

const inputStyle = {
  width: '100%',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '10px 12px',
  color: '#e2e8f0',
  fontSize: 14,
  boxSizing: 'border-box',
  outline: 'none',
};

const labelStyle = {
  display: 'block',
  fontSize: 12,
  color: '#94a3b8',
  fontWeight: 500,
  marginBottom: 6,
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showToast, toastEl] = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const { error } = await signIn.email({ email, password, rememberMe: true });
      if (error) {
        showToast('Login failed: ' + (error.message || error.statusText || 'invalid credentials'), 'error');
        setSubmitting(false);
        return;
      }
      // On success the session cookie is set; the App guard re-renders into the app once
      // useSession refetches. A full reload guarantees every page picks up the session.
      window.location.reload();
    } catch (err) {
      showToast('Login failed: ' + (err?.message || 'network error'), 'error');
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0f1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#131720',
          border: '1px solid #1e2433',
          borderRadius: 12,
          padding: '32px 28px',
          width: '100%',
          maxWidth: 360,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 800, fontSize: 20, color: '#e2e8f0' }}>Sign in</div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>Print Farm Manager</div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle} htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={inputStyle}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#334155'; }}
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={labelStyle} htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#334155'; }}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          style={{
            width: '100%',
            background: submitting ? '#1e3a8a' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '10px 14px',
            fontSize: 14,
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
      {toastEl}
    </div>
  );
}
