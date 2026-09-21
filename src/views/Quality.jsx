/**
 * Data quality.
 *
 * The caveats promoted to a screen rather than buried in a footnote: what the
 * reference scrape has not reached yet, what the matcher is unsure about, and
 * which feeds are excluded from the headline.
 */

import { useMemo } from 'react';
import { runFilter, summarise, EMPTY } from '../lib/filters.js';
import { Panel, Kpi, Icon, Tag, n0, n1, compact } from '../components/ui.jsx';
import { useTip, LinkageBars, ConfidenceArc } from '../components/charts.jsx';

export default function Quality({ store, onNavigate, setFilters }) {
  const { meta, P, D } = store;
  const cov = meta.coverage;
  const h = meta.headline;
  const tip = useTip();

  const all = useMemo(() => runFilter(store, EMPTY, { key: 'listed', dir: 'desc' }).rows, [store]);
  const stats = useMemo(() => summarise(store, all), [store, all]);

  const gapIdx = D.gapIndex ?? {};
  const backlog = useMemo(() => all
    .filter((i) => D.gap[P.gap[i]] === 'di_miss')
    .slice(0, 12), [all, D, P]);

  const review = useMemo(() => all
    .filter((i) => D.review[P.review[i]] === 'needs_review')
    .sort((a, b) => P.nListed[b] - P.nListed[a])
    .slice(0, 12), [all, D, P]);

  const quarantined = meta.pharmacies.filter((p) => p.present_in_snapshot && p.quarantined);
  const jump = (patch) => { setFilters({ ...EMPTY, ...patch }); onNavigate('catalogue'); };

  const linkage = [
    { label: 'Brand → active ingredient', value: cov.link_brand_to_ingredient, note: `${n0(cov.brands_with_ingredient)} of ${n0(cov.brands_rows)} brands` },
    { label: 'Brand → manufacturer', value: cov.link_brand_to_manufacturer, note: `${n0(cov.brands_with_manufacturer)} of ${n0(cov.brands_rows)} brands` },
    { label: 'Ingredient → indications', value: cov.link_ingredient_to_indications, note: `${n0(cov.ingredients_with_indications)} of ${n0(cov.ingredients_rows)} ingredients` },
    { label: 'Ingredient → dosage', value: cov.link_ingredient_to_dosage, note: `${n0(cov.ingredients_with_dosage)} of ${n0(cov.ingredients_rows)}` },
    { label: 'Ingredient → contraindications', value: cov.link_ingredient_to_contraindications, note: `${n0(cov.ingredients_with_contraindications)} of ${n0(cov.ingredients_rows)}` },
    {
      label: 'Ingredient → therapeutic category',
      value: cov.link_ingredient_to_category,
      note: `${n0(cov.ingredients_with_category)} of ${n0(cov.ingredients_rows)} ingredients`,
    },
  ];

  return (
    <div className="page">
      {tip.node}
      <header className="page-head">
        <div className="eyebrow">Trust</div>
        <h1 className="h1" style={{ marginTop: 5 }}>Data quality</h1>
        <p className="sub" style={{ marginTop: 7, marginBottom: 0, maxWidth: 640 }}>
          What this snapshot does not know, stated plainly. The reference scrape is unfinished, so
          classification is provisional and expected to improve rather than to be re-litigated.
        </p>
      </header>

      <div className="stack">
      <div className="kpis">
        <Kpi label="Catalogue matched to register" value={n1(100 * cov.drugindex_match_rate)} unit="%"
          note={<>{n0(cov.products_with_drugindex_match)} of {n0(cov.products_total)} products</>} />
        <Kpi label="Blocked on reference data" value={compact(cov.products_awaiting_drugindex)}
          tone="var(--warn)"
          note={<>{n1(100 * cov.catalogue_blocked_on_drugindex)}% — should fall as scraping continues</>} />
        <Kpi label="Genuinely ambiguous" value={compact(cov.products_unclassified - cov.products_awaiting_drugindex)}
          note={<>more reference data will not help these</>} />
        <Kpi label="In review" value={compact(review.length >= 12 ? stats.total - all.filter((i) => D.review[P.review[i]] === 'auto').length : review.length)}
          note={<>doubtful match or contested class</>} />
        <Kpi label="Feeds excluded" value={quarantined.length}
          note={<>of {h.pharmacies} — no stock signal published</>} />
      </div>

      <div className="notice">
        <Icon name="alert" size={13} />
        <div>
          <b>The DrugIndex scrape is still running.</b> {n0(cov.brands_rows)} brands and{' '}
          {n0(cov.ingredients_rows)} active ingredients captured so far, across{' '}
          {cov.distinct_scrape_days} collection days to {String(cov.latest_updated_at ?? '').slice(0, 10)}.
          Coverage figures below measure linkage between records held — they are not a percentage
          of an assumed total, which cannot be known from inside the data.
        </div>
      </div>

      <div className="grid grid-stretch" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <Panel eyebrow="Reference data" title="Field coverage"
          foot="Linkage between records held, never a percentage of an unknown total. Therapeutic class reaches a product only through a matched active ingredient, so product-level coverage is lower than the ingredient linkage shown here.">
          <LinkageBars items={linkage} tip={tip} />
        </Panel>

        <Panel eyebrow="Resolution" title="Match confidence"
          foot="Low-confidence cross-source matches are held out of the shortage signal entirely.">
          <ConfidenceArc counts={stats.byMatch} labels={D.matchBand} tip={tip} size={130} />
          <div className="tiny dim" style={{ marginTop: 14, lineHeight: 1.55 }}>
            The choice of matching key moves the headline shortage count on its own. Under exact
            name equality the count is 1; under this key it is 2, and 0 once filtered to medicines
            and devices. The key is versioned and every figure derived from it is labelled.
          </div>
        </Panel>
      </div>

      <div className="grid grid-stretch" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <Panel eyebrow={`${compact(cov.products_awaiting_drugindex)} products`}
          title="Awaiting reference data" pad={false}
          actions={
            <button className="btn btn-sm btn-ghost"
              onClick={() => jump({ gaps: [D.gap.indexOf('di_miss')].filter((x) => x >= 0) })}>
              Open all →
            </button>
          }
          foot="Unclassified with no register match and no usable source category. Ordered by how many pharmacies list them — the highest-value gaps first.">
          <table className="tbl">
            <thead>
              <tr><th>Product</th><th className="r" style={{ width: 70 }}>Listed</th></tr>
            </thead>
            <tbody>
              {backlog.map((i) => (
                <tr key={P.key[i]} onClick={() => jump({ q: P.name[i] })}>
                  <td className="cell-name">{P.name[i]}</td>
                  <td className="r num">{P.nListed[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel eyebrow="Human adjudication" title="Review queue" pad={false}
          actions={
            <button className="btn btn-sm btn-ghost" onClick={() => jump({ review: 'needs_review' })}>
              Open all →
            </button>
          }
          foot="Doubtful matches and contested classifications, worst first. These are excluded from the shortage signal.">
          <table className="tbl">
            <thead>
              <tr><th>Product</th><th style={{ width: 96 }}>Reason</th><th className="r" style={{ width: 62 }}>Match</th></tr>
            </thead>
            <tbody>
              {review.map((i) => (
                <tr key={P.key[i]} onClick={() => jump({ q: P.name[i] })}>
                  <td className="cell-name">{P.name[i]}</td>
                  <td className="tiny">
                    {P.contested[i] ? <Tag tone="warn">class</Tag> : <Tag tone="plain">match</Tag>}
                  </td>
                  <td className="r num" style={{ color: 'var(--warn)' }}>{P.matchConf[i].toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel eyebrow="Excluded from network metrics" title="Quarantined feeds"

        foot="A feed that never emits an out-of-stock value is not a source at full availability; it is a source that does not report. Counting it as positive evidence is what inflates the unfiltered rate.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {quarantined.map((p) => (
            <div key={p.pharmacy_id} className="row" style={{ fontSize: 12, alignItems: 'flex-start' }}>
              <span style={{ fontWeight: 500, minWidth: 140 }}>{p.name}</span>
              <span className="num dim" style={{ minWidth: 60 }}>{n0(p.listings)}</span>
              <span className="dim" style={{ flex: 1 }}>{p.health_detail}</span>
            </div>
          ))}
        </div>
        <div className="tiny dim" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-faint)', lineHeight: 1.6 }}>
          Including them would move the headline from{' '}
          <b className="num" style={{ color: 'var(--ink)' }}>{n1(h.in_stock_rate_gated)}%</b> to{' '}
          <b className="num" style={{ color: 'var(--ink)' }}>{n1(h.in_stock_rate_raw)}%</b>, by
          treating {n0(h.not_published)} listings with no stock signal as available.
        </div>
      </Panel>
      </div>
    </div>
  );
}
