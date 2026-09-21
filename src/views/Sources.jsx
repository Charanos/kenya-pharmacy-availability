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
import { Section, Icon, Tag, n0, n1, compact } from '../components/ui.jsx';
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

  // Concentration matters because a panel rate is a weighted average: when
  // three catalogues carry most of the listings, the network number is largely
  // theirs and a single feed's behaviour moves it.
  const concentration = useMemo(() => {
    const sorted = [...present].sort((a, b) => b.listings - a.listings);
    const total = sorted.reduce((a, p) => a + p.listings, 0) || 1;
    const top3 = (100 * sorted.slice(0, 3).reduce((a, p) => a + p.listings, 0)) / total;
    return { top3, leader: sorted[0]?.name ?? '—' };
  }, [present]);

  return (
    <div className="page sources-page">
      {tip.node}
      <header className="page-head sources-head">
        <div className="eyebrow">Network</div>
        <h1 className="h1">Sources</h1>
        <p className="sub sources-lede">
          {present.length} pharmacy catalogues captured, {reporting.length} of which publish an
          out-of-stock state. {absent.length} more are in the panel but absent from this snapshot.
        </p>
      </header>

      <div className="stack sources-stack">
      <section className="sources-status-strip" aria-label="Source reporting summary">
        <div><span>Captured</span><b className="num">{present.length}</b><small>catalogues</small></div>
        <div><span>Reporting</span><b className="num">{reporting.length}</b><small>stock states</small></div>
        <div><span>Quarantined</span><b className="num">{present.length - reporting.length}</b><small>no usable signal</small></div>
        <div><span>Absent</span><b className="num">{absent.length}</b><small>this snapshot</small></div>
      </section>

      <div className="sources-network-grid">
        <Section className="sources-availability" eyebrow="Catalogue size and availability" title="Observed availability"
          caption={<>
            Hatched sources publish no stock signal; their listing count is real but no rate can be
            derived. The largest three catalogues hold <b>{n1(concentration.top3)}%</b> of all
            listings, so the panel-wide rate is substantially {concentration.leader}&rsquo;s rate.
          </>}>
          <SourceBars rows={breakdown} tip={tip}
            onPick={(bit) => { setFilters({ ...EMPTY, shopsAny: [bit] }); onNavigate('catalogue'); }} />
        </Section>

        <Section className="sources-roster" eyebrow="Signal quality" title="Reporting posture">
          <div className="sources-roster-list">
            {present.map((p) => (
              <div key={p.pharmacy_id} className="sources-roster-row">
                <span className="trunc">{p.name}</span>
                {p.quarantined
                  ? <Tag tone="warn">{p.health_flags === 'implausible_row_count' ? 'scrape failed' : 'no stock signal'}</Tag>
                  : <Tag tone="in">reports stock</Tag>}
                <span className="num tiny dim">
                  {compact(p.listings)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section className="sources-ledger" eyebrow="Detail" title="Source ledger" flush>
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
                    <tr key={`${p.pharmacy_id}-d`} className="sources-detail-row">
                      <td colSpan={8}>
                        <dl className="kv sources-detail-kv">
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
                        <button className="btn btn-sm sources-detail-action"
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
      </Section>

      {absent.length > 0 && (
        <Section className="sources-absent" eyebrow="Panel members" title="Absent from this snapshot"
          caption="Carried explicitly so the denominator change stays visible rather than silently shrinking the network.">
          <div className="sources-absent-list">
            {absent.map((p) => (
              <div key={p.pharmacy_id} className="sources-absent-row">
              <Icon name="alert" size={13} className="dim" />
                <span>{p.name}</span>
                <span className="dim">{p.absent_reason}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      </div>
    </div>
  );
}
