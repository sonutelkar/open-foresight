import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getConfig, type Auth, type Config } from './api';
import { BriefForm } from './BriefForm';
import { RunPage } from './RunPage';
import './styles.css';

const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* the browser may block storage */ } };
const route = () => /^#\/runs\/([0-9a-f-]{36})$/.exec(window.location.hash)?.[1];

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [auth, setAuth] = useState<Auth>({ analyst: read('of.analyst'), token: read('of.token') });
  const [runId, setRunId] = useState(route());
  useEffect(() => { getConfig().then(setConfig).catch(e => setError(e instanceof Error ? e.message : 'Could not reach the API')); }, []);
  useEffect(() => { const on = () => setRunId(route()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const update = (patch: Partial<Auth>) => setAuth(a => { const next = { ...a, ...patch }; write('of.analyst', next.analyst); write('of.token', next.token); return next; });

  return (
    <>
      <nav className="topbar">
        <a className="brand" href="#/"><span className="brand-mark" aria-hidden />Open Foresight</a>
        <div className="approver" aria-label="Approver">
          <label>Analyst <input data-testid="analyst" value={auth.analyst} onChange={e => update({ analyst: e.target.value })} placeholder="Your name" autoComplete="off" maxLength={80} /></label>
          <label>Approver token <input data-testid="token" type="password" value={auth.token} onChange={e => update({ token: e.target.value })} placeholder="From the server" autoComplete="off" /></label>
        </div>
      </nav>
      <main>
        {error && <div className="page"><div className="banner bad" role="alert">{error}</div></div>}
        {config && (runId ? <RunPage key={runId} id={runId} config={config} auth={auth} onAuth={update} /> : <BriefForm config={config} auth={auth} onCreated={id => { window.location.hash = `#/runs/${id}`; }} />)}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
