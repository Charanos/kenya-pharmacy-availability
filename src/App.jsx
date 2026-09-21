/**
 * Application shell.
 *
 * Filter state lives here and is mirrored into the URL, so any view of the
 * data is a link. That is not a nicety for an analyst tool -- it is how a
 * finding gets sent to someone else.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadStore, loadListings } from './lib/store.js';
import { EMPTY, encodeFilters, decodeFilters, runFilter } from './lib/filters.js';
import { Icon, compact, n1, fmtDate } from './components/ui.jsx';
import Overview from './views/Overview.jsx';
import Catalogue from './views/Catalogue.jsx';
import Sources from './views/Sources.jsx';
import Quality from './views/Quality.jsx';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'pulse' },
  { id: 'catalogue', label: 'Catalogue', icon: 'grid' },
  { id: 'sources', label: 'Sources', icon: 'layers' },
  { id: 'quality', label: 'Data quality', icon: 'shield' },
];

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return { view: p.get('v') || 'overview', filters: decodeFilters(p) };
}

export default function App() {
  const [store, setStore] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ stage: 'meta', progress: 0 });

  const initial = useMemo(readUrl, []);
  const [view, setView] = useState(initial.view);
  const [filters, setFilters] = useState(initial.filters);
  const [theme, setTheme] = useState(() => localStorage.getItem('kpad-theme') || 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('kpad-theme', theme); } catch { /* private mode */ }
  }, [theme]);

  useEffect(() => {
    let alive = true;
    loadStore((s) => alive && setProgress(s))
      .then((s) => {
        if (!alive) return;
        setStore(s);
        // Per-listing detail is only needed once a drawer opens, so it loads
        // in the background after the grid is already interactive.
        loadListings(s).catch(() => { /* drawer retries on demand */ });
      })
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, []);

  // Mirror view and filters into the URL without stacking history entries.
  useEffect(() => {
    const p = encodeFilters(filters);
    if (view !== 'overview') p.set('v', view);
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters, view]);

  useEffect(() => {
    const onPop = () => { const u = readUrl(); setView(u.view); setFilters(u.filters); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // "/" focuses search from anywhere, as in every serious data tool.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !/input|textarea/i.test(e.target.tagName)) {
        e.preventDefault();
        setView('catalogue');
        requestAnimationFrame(() => document.querySelector('[data-search] input')?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = useCallback((v) => setView(v), []);

  if (error) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <Icon name="alert" size={22} />
        <div className="h2">Could not load the read model</div>
        <div className="tiny dim" style={{ maxWidth: 420 }}>{String(error.message || error)}</div>
        <div className="tiny faint">
          Run <code className="mono">npm run build &amp;&amp; npm run export:app</code> to regenerate it.
        </div>
      </div>
    );
  }

  if (!store) return <Loading progress={progress} />;

  const { meta } = store;
  const snapshotDate = fmtDate(meta.headline.snapshot_at, { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-head">
          <div className="rail-mark">KP</div>
          <div className="rail-word">
            Kenya Pharmacy
            <small>Availability intelligence</small>
          </div>
        </div>

        <div className="rail-nav">
          <div className="rail-label">Workspace</div>
          {NAV.map((n) => (
            <button key={n.id} className="rail-item" aria-current={view === n.id}
              onClick={() => navigate(n.id)}>
              <Icon name={n.icon} size={15} />
              <span>{n.label}</span>
              {n.id === 'catalogue' && <span className="tail">{compact(store.P.n)}</span>}
              {n.id === 'sources' && <span className="tail">{store.shops.length}</span>}
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <div style={{ fontSize: 10, color: 'var(--rail-ink-dim)', lineHeight: 1.6 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Snapshot</span>
              <span className="mono" style={{ color: 'var(--rail-ink)' }}>{meta.run.snapshot_id}</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Contract</span>
              <span className="mono">{meta.contract_version}</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Match</span>
              <span className="mono">{meta.run.match_algo_version}</span>
            </div>
          </div>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="field" data-search style={{ width: 340 }}>
            <Icon name="search" size={14} />
            <input
              value={filters.q}
              onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setView('catalogue'); }}
              placeholder="Search products and ingredients…"
            />
            <kbd className="micro faint mono" style={{
              border: '1px solid var(--line)', borderRadius: 3, padding: '0 4px',
            }}>/</kbd>
          </div>

          <div className="row spacer" style={{ gap: 9 }}>
            <span className="row tiny dim" title="Snapshot timestamp is inferred from source file mtime">
              <i style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--in)', display: 'block',
              }} />
              {snapshotDate}
              {meta.run.snapshot_at_inferred && <span className="faint">inferred</span>}
            </span>
            <button className="btn btn-icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
              <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
            </button>
            <button className="btn" onClick={() => exportCsv(store, filters)}>
              <Icon name="download" size={13} /> Export
            </button>
          </div>
        </header>

        {view === 'catalogue' ? (
          <Catalogue store={store} filters={filters} setFilters={setFilters} />
        ) : (
          <div className="scroll">
            {view === 'overview' && <Overview store={store} onNavigate={navigate} setFilters={setFilters} />}
            {view === 'sources' && <Sources store={store} onNavigate={navigate} setFilters={setFilters} />}
            {view === 'quality' && <Quality store={store} onNavigate={navigate} setFilters={setFilters} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- loading -- */

function Loading({ progress }) {
  const pct = Math.round(progress.progress * 100);
  return (
    <div className="empty" style={{ height: '100vh', gap: 14 }}>
      <div className="rail-mark" style={{ width: 34, height: 34, fontSize: 12 }}>KP</div>
      <div className="h3">Kenya Pharmacy Availability</div>
      <div style={{ width: 200, height: 2, background: 'var(--line)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${Math.max(6, pct)}%`, background: 'var(--accent)',
          transition: 'width .2s ease',
        }} />
      </div>
      <div className="micro faint mono">
        {progress.stage === 'meta' ? 'reading snapshot…' : `products ${pct}%`}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- export -- */

/** Exports exactly what is on screen, filters included, as CSV. */
function exportCsv(store, filters) {
    const { P, D } = store;
    const rows = runFilter(store, filters, { key: 'oos', dir: 'desc' }).rows;
    const head = [
      'product_key', 'name', 'type', 'is_clinical', 'form', 'pack', 'active_ingredient',
      'pharmacies_listing', 'pharmacies_eligible', 'pharmacies_oos', 'pharmacies_in_stock',
      'cluster_band', 'price_min', 'price_median', 'price_max',
      'match_confidence', 'match_band', 'review_state', 'class_gap_reason',
      ...store.shops.map((s) => s.pharmacy_id),
    ];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [head.join(',')];
    for (const i of rows) {
      const cells = [
        P.key[i], P.name[i], D.type[P.type[i]], P.clinical[i] ? 'yes' : 'no',
        P.form[i] >= 0 ? D.form[P.form[i]] : '', P.packSig[i],
        P.ingredient[i] >= 0 ? D.ingredient[P.ingredient[i]] : '',
        P.nListed[i], P.nEligible[i], P.nOos[i], P.nIn[i],
        D.band[P.band[i]],
        Number.isFinite(P.priceMin[i]) ? P.priceMin[i] : '',
        Number.isFinite(P.priceMed[i]) ? P.priceMed[i] : '',
        Number.isFinite(P.priceMax[i]) ? P.priceMax[i] : '',
        P.matchConf[i].toFixed(3), D.matchBand[P.matchBand[i]],
        D.review[P.review[i]], P.gap[i] >= 0 ? D.gap[P.gap[i]] : '',
        ...store.shops.map((s) => {
          const bit = 1 << s.bit;
          if (!(P.listedMask[i] & bit)) return '';
          if (P.oosMask[i] & bit) return 'out_of_stock';
          if (P.inMask[i] & bit) return 'in_stock';
          return 'not_published';
        }),
      ];
      lines.push(cells.map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kenya-pharmacy-${store.meta.run.snapshot_id}-${rows.length}-products.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}
