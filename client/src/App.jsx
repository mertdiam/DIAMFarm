import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Fleet from './pages/Fleet';
import Printers from './pages/Printers';
import PrinterDetail from './pages/PrinterDetail';
import Projects from './pages/Projects';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';
import Decommissioned from './pages/Decommissioned';
import Login from './pages/Login';
import Users from './pages/Users';
import { useSession, signOut } from './lib/authClient';

// `adminOnly` items are filtered out for operators. The server enforces the same split;
// hiding the nav entry is a convenience, not the security boundary.
const NAV_ITEMS = [
  { to: '/',               label: 'Dashboard' },
  { to: '/fleet',          label: 'Fleet' },
  { to: '/printers',       label: 'Printers',      end: true },
  { to: '/projects',       label: 'Projects' },
  { to: '/jobs',           label: 'Jobs' },
  { to: '/decommissioned', label: 'Decommissioned' },
  { to: '/settings',       label: 'Settings' },
  { to: '/users',          label: 'Users',         adminOnly: true },
];

const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  padding: '8px 14px',
  borderRadius: 6,
  color: isActive ? '#fff' : '#94a3b8',
  background: isActive ? '#1e40af' : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 400,
  fontSize: 14,
  transition: 'background 0.15s',
  whiteSpace: 'nowrap',
});

const signOutBtnStyle = {
  marginTop: 'auto',
  background: 'none',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#94a3b8',
  fontSize: 13,
  padding: '8px 14px',
  cursor: 'pointer',
  textAlign: 'left',
};

export default function App() {
  // Session guard. While the session is resolving, show a neutral loading screen; when there
  // is no session, render the standalone Login page (no nav shell). Both the sidebar and the
  // route table below are gated on an authenticated session.
  const { data: session, isPending } = useSession();

  // Operator-configurable farm name (Settings → Farm Name)
  const [farmName, setFarmName] = useState('Print Farm');
  useEffect(() => {
    if (!session) return; // only fetch app data once authenticated
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.farm_name) setFarmName(data.farm_name); })
      .catch(() => {});

    // Settings page dispatches this on save so the sidebar/topbar update live,
    // without needing a full page refresh.
    const onFarmNameChanged = (e) => setFarmName(e.detail);
    window.addEventListener('farmNameChanged', onFarmNameChanged);
    return () => window.removeEventListener('farmNameChanged', onFarmNameChanged);
  }, [session]);

  // Loading state while the session resolves. Matches the app's dark page background.
  if (isPending) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0f1a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 14 }}>
        Loading...
      </div>
    );
  }

  // Unauthenticated: standalone login, no nav shell.
  if (!session) return <Login />;

  const roles = (session.user?.role || '').split(',').map((r) => r.trim());
  const isAdmin = roles.includes('admin');
  const navItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <BrowserRouter>
      {/* Responsive layout: sidebar on desktop, top nav bar on mobile */}
      <style>{`
        #layout { display: flex; min-height: 100vh; }
        #sidebar { width: 180px; flex-shrink: 0; background: #131720; border-right: 1px solid #1e2433; display: flex; flex-direction: column; padding: 16px 8px; gap: 4px; }
        #topbar { display: none; background: #131720; border-bottom: 1px solid #1e2433; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; }
        #main { flex: 1; padding: 24px 28px; overflow-y: auto; min-width: 0; }
        @media (max-width: 600px) {
          #layout { flex-direction: column; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main { padding: 16px 14px; }
        }
      `}</style>

      <div id="layout">
        {/* Sidebar (desktop) */}
        <nav id="sidebar">
          <div style={{ padding: '0 6px 16px', borderBottom: '1px solid #1e2433', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="19" height="23" viewBox="0 0 64 64" aria-hidden="true" style={{ flex: 'none' }}>
                <rect x="21" y="12" width="22" height="12" rx="2.5" fill="#e2e8f0" />
                <path d="M25 24 H39 L33.5 39 H30.5 Z" fill="#e2e8f0" />
                <rect x="30" y="38.6" width="4" height="2" rx="0.6" fill="#e2e8f0" />
                <line x1="32" y1="41" x2="32" y2="47" stroke="#2563eb" strokeWidth="2.6" strokeLinecap="round" />
                <rect x="24.5" y="49" width="15" height="3.4" rx="1.7" fill="#2563eb" />
              </svg>
              <div style={{ fontSize: 17, letterSpacing: '-0.01em', lineHeight: 1, color: '#e2e8f0', fontFamily: '"Montserrat","Century Gothic","Futura","Avenir Next",system-ui,sans-serif' }}>
                <span style={{ fontWeight: 300 }}>DIAM</span><span style={{ fontWeight: 800 }}>FARM</span>
              </div>
            </div>
            <div style={{ fontWeight: 400, fontSize: 11, color: '#475569', marginTop: 6 }}>{farmName}</div>
          </div>
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/' || !!item.end} style={navLinkStyle}>
              {item.label}
            </NavLink>
          ))}
          <button onClick={() => signOut().then(() => window.location.reload())} style={signOutBtnStyle}>
            Sign out
          </button>
        </nav>

        {/* Top nav bar (mobile) */}
        <nav id="topbar">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 8 }}>
            <svg width="15" height="18" viewBox="0 0 64 64" aria-hidden="true" style={{ flex: 'none' }}>
              <rect x="21" y="12" width="22" height="12" rx="2.5" fill="#e2e8f0" />
              <path d="M25 24 H39 L33.5 39 H30.5 Z" fill="#e2e8f0" />
              <circle cx="32" cy="49" r="4.5" fill="#2563eb" />
            </svg>
            <span style={{ fontSize: 14, color: '#e2e8f0', fontFamily: '"Montserrat","Century Gothic","Futura","Avenir Next",system-ui,sans-serif' }}>
              <span style={{ fontWeight: 300 }}>DIAM</span><span style={{ fontWeight: 800 }}>FARM</span>
            </span>
          </span>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/' || !!item.end}
              style={({ isActive }) => ({
                padding: '5px 10px',
                borderRadius: 6,
                color: isActive ? '#fff' : '#94a3b8',
                background: isActive ? '#1e40af' : '#1e2433',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: isActive ? 700 : 400,
              })}
            >
              {item.label}
            </NavLink>
          ))}
          <button
            onClick={() => signOut().then(() => window.location.reload())}
            style={{ padding: '5px 10px', borderRadius: 6, color: '#94a3b8', background: '#1e2433', border: 'none', fontSize: 13, cursor: 'pointer' }}
          >
            Sign out
          </button>
        </nav>

        {/* Main content */}
        <main id="main">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/fleet"           element={<Fleet />} />
            <Route path="/printers"        element={<Printers />} />
            <Route path="/printers/:id"    element={<PrinterDetail />} />
            <Route path="/projects"        element={<Projects />} />
            <Route path="/jobs"            element={<Jobs />} />
            <Route path="/decommissioned"  element={<Decommissioned />} />
            <Route path="/settings"        element={<Settings />} />
            {isAdmin && <Route path="/users" element={<Users />} />}
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
