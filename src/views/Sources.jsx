/**
 * Sources — one row per pharmacy, plus feed provenance.
 *
 * A quarantined feed is never rendered as a rate. "100% available" from a shop
 * that has never emitted an out-of-stock value is not a fact about its shelves,
 * and publishing it as one has already been wrong once: Pharmily read 0% in
 * June and 75.9% in September.
 */

import { useMemo, useState } from 'react';
import { runFilter, sourceBreakdown, EMPTY } from '../lib/filters.js';
import { Panel, Icon, Tag, n0, n1, compact } from '../components/ui.jsx';
import { useTip, SourceBars } from '../components/charts.jsx';

export default function Sources({ store, onNavigate, setFilters }) {
  const { meta } = store;
  const tip = useTip();
  const [open, setOpen] = useState(null);

  const all = useMemo(() => runFilter(store, EMPTY, { key: 'oos', dir: 'desc' }).rows, [store]);
  const breakdown = useMemo(() => sourceBreakdown(store, all), [store, all]);
  const byId = Object.fromEntries(breakdown.map((b) => [b.shop.pharmacy_id, b]));

  const present = meta.pharmacies.filter((p) => p.present_in_snapshot);
  const absent = meta.pharmacies.filter((p) => !p.present_in_snapshot);
  const reporting = present.filter((p) => p.publishes_oos);

  return (
    <div className="page">
      {tip.node}
      <header className="page-head">
        <div className="eyebrow">Network</div>
        <h1 className="h1" style={{ marginTop: 5 }}>Sources</h1>
        <p className="sub" style={{ marginTop: 7, marginBottom: 0, maxWidth: 640 }}>
          {present.length} pharmacy catalogues captured, {reporting.length} of which publish an
          out-of-stock state. {absent.length} more are in the panel but absent from this snapshot.
        </p>
      </header>

      <div className="stack">
      <div className="grid grid-stretch" style={{ gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)' }}>
        <Panel eyebrow="Catalogue size and availability" title="Every source"
          foot="Hatched sources publish no stock signal; their listing count is real but no rate can be derived.">
          <SourceBars rows={breakdown} tip={tip}
            onPick={(bit) => { setFilters({ ...EMPTY, shopsAny: [bit] }); onNavigate('catalogue'); }} />
        </Panel>

        <Panel eyebrow="Signal quality" title="What each feed publishes">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {present.map((p) => (
              <div key={p.pharmacy_id} className="row" style={{ fontSize: 12 }}>
                <span className="trunc" style={{ flex: 1 }}>{p.name}</span>
                {p.quarantined
                  ? <Tag tone="warn">{p.health_flags === 'implausible_row_count' ? 'scrape failed' : 'no stock signal'}</Tag>
                  : <Tag tone="in">reports stock</Tag>}
                <span className="num tiny dim" style={{ width: 54, textAlign: 'right' }}>
                  {compact(p.listings)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel eyebrow="Detail" title="Source ledger" pad={false}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Source</th>
              <th>Platform</th>
              <th className="r">Listings</th>
              <th className="r">In stock</th>
              <th className="r">Out</th>
              <th className="r">Observed</th>
              <th>Signal</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {present.map((p) => {
              const b = byId[p.pharmacy_id];
              const expanded = open === p.pharmacy_id;
              return (
                <>
                  <tr key={p.pharmacy_id} onClick={() => setOpen(expanded ? null : p.pharmacy_id)}
                    data-active={expanded}>
                    <td style={{ fontWeight: 500 }}>{p.name}</td>
                    <td className="dim tiny">{p.platform}</td>
                    <td className="r num">{n0(p.listings)}</td>
                    <td className="r num">{p.publishes_oos ? n0(p.in_stock) : '—'}</td>
                    <td className="r num" style={{ color: p.out_of_stock ? 'var(--out)' : undefined }}>
                      {p.publishes_oos ? n0(p.out_of_stock) : '—'}
                    </td>
                    <td className="r num">
                      {p.publishes_oos && b?.rate != null ? `${n1(b.rate)}%` : <span className="faint">—</span>}
                    </td>
                    <td>
                      {p.quarantined ? <Tag tone="warn">quarantined</Tag> : <Tag tone="in">reporting</Tag>}
                    </td>
                    <td className="c dim"><Icon name={expanded ? 'up' : 'down'} size={12} /></td>
                  </tr>
                  {expanded && (
                    <tr key={`${p.pharmacy_id}-d`} style={{ cursor: 'default' }}>
                      <td colSpan={8} style={{ height: 'auto', padding: '12px 10px 16px', background: 'var(--surface-sunk)' }}>
                        <dl className="kv" style={{ gridTemplateColumns: '150px 1fr', maxWidth: 720 }}>
                          <dt>Scrape method</dt><dd>{p.scrape_method}</dd>
                          <dt>Listing identity</dt><dd className="mono micro">{p.listing_key_strategy}</dd>
                          <dt>Distinct stock values</dt><dd className="num">{p.distinct_status_values}</dd>
                          {p.rows_skipped > 0 && (<><dt>Rows skipped</dt><dd className="num">{n0(p.rows_skipped)}</dd></>)}
                          {p.urls_repaired > 0 && (
                            <><dt>URLs repaired</dt>
                              <dd className="num">{n0(p.urls_repaired)} <span className="dim tiny">malformed at source</span></dd></>
                          )}
                          {p.health_detail && (
                            <><dt>Health</dt><dd style={{ color: 'var(--warn)' }}>{p.health_detail}</dd></>
                          )}
                        </dl>
                        <button className="btn btn-sm" style={{ marginTop: 12 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFilters({ ...EMPTY, shopsAny: [b.shop.bit] });
                            onNavigate('catalogue');
                          }}>
                          View {compact(p.listings)} products <Icon name="right" size={11} />
                        </button>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {absent.length > 0 && (
        <Panel eyebrow="Panel members" title="Absent from this snapshot"
          foot="Carried explicitly so the denominator change stays visible rather than silently shrinking the network.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {absent.map((p) => (
              <div key={p.pharmacy_id} className="row" style={{ fontSize: 12 }}>
                <Icon name="alert" size={13} className="dim" />
                <span style={{ fontWeight: 500, minWidth: 120 }}>{p.name}</span>
                <span className="dim">{p.absent_reason}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      </div>
    </div>
  );
}
