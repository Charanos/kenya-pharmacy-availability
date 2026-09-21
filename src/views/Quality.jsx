/**
 * Data quality.
 *
 * The caveats promoted to a screen rather than buried in a footnote: what the
 * reference scrape has not reached yet, what the matcher is unsure about, and
 * which feeds are excluded from the headline.
 *
 * Every figure here is a linkage between records actually held. None of them
 * is a percentage of an assumed total, because the size of the real drug
 * register is not knowable from inside the data.
 */

import { useMemo } from 'react';
import { runFilter, summarise, EMPTY } from '../lib/filters.js';
import { Section, Kpi, Icon, Tag, n0, n1, compact } from '../components/ui.jsx';
import { useTip, LinkageBars, ConfidenceArc } from '../components/charts.jsx';

const QUEUE_ROWS = 12;

export default function Quality({ store, onNavigate, setFilters }) {
  const { meta, P, D } = store;
  const cov = meta.coverage;
  const h = meta.headline;
  const tip = useTip();

  const all = useMemo(() => runFilter(store, EMPTY, { key: 'listed', dir: 'desc' }).rows, [store]);
  const stats = useMemo(() => summarise(store, all), [store, all]);

  const backlog = useMemo(
    () => all.filter((i) => D.gap[P.gap[i]] === 'di_miss'),
    [all, D, P],
  );

  const review = useMemo(
    () => all
      .filter((i) => D.review[P.review[i]] === 'needs_review')
      .sort((a, b) => P.nListed[b] - P.nListed[a]),
    [all, D, P],
  );

  // Therapeutic class is reached only through a matched active ingredient, so
  // product coverage is strictly lower than the ingredient linkage. Ranked,
  // because the useful question is which classes the register actually reaches.
  const classCoverage = useMemo(() => {
    const counts = new Int32Array(D.therapeutic?.length ?? 0);
    let classed = 0;
    for (const i of all) {
      const t = P.therapeutic[i];
      if (t >= 0) { counts[t]++; classed++; }
    }
    const rows = Array.from(counts)
      .map((n, i) => ({ label: D.therapeutic[i], n }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);
    return { rows, classed, peak: Math.max(1, ...rows.map((r) => r.n)) };
  }, [all, D, P]);

  const quarantined = meta.pharmacies.filter((p) => p.present_in_snapshot && p.quarantined);
  const jump = (patch) => { setFilters({ ...EMPTY, ...patch }); onNavigate('catalogue'); };

  const linkage = [
    { label: 'Brand → active ingredient', value: cov.link_brand_to_ingredient, note: `${n0(cov.brands_with_ingredient)} of ${n0(cov.brands_rows)} brands` },
    { label: 'Brand → manufacturer', value: cov.link_brand_to_manufacturer, note: `${n0(cov.brands_with_manufacturer)} of ${n0(cov.brands_rows)} brands` },
    { label: 'Ingredient → indications', value: cov.link_ingredient_to_indications, note: `${n0(cov.ingredients_with_indications)} of ${n0(cov.ingredients_rows)} ingredients` },
    { label: 'Ingredient → dosage', value: cov.link_ingredient_to_dosage, note: `${n0(cov.ingredients_with_dosage)} of ${n0(cov.ingredients_rows)} ingredients` },
    { label: 'Ingredient → contraindications', value: cov.link_ingredient_to_contraindications, note: `${n0(cov.ingredients_with_contraindications)} of ${n0(cov.ingredients_rows)} ingredients` },
    { label: 'Ingredient → therapeutic category', value: cov.link_ingredient_to_category, note: `${n0(cov.ingredients_with_category)} of ${n0(cov.ingredients_rows)} ingredients` },
  ];

  return (
    <div className="page quality-page">
      {tip.node}

      <header className="page-head quality-head">
        <div className="eyebrow">Trust</div>
        <h1 className="h1">Data quality</h1>
        <p className="sub quality-lede">
          What this snapshot does not know, stated plainly. The reference scrape is unfinished, so
          classification is provisional and expected to improve rather than to be re-litigated.
        </p>
      </header>

      <div className="stack quality-stack">
        {/* ------------------------------------------------- headline --- */}
        <section className="section quality-pulse">
          <div className="kpis">
            <Kpi label="Catalogue matched" value={n1(100 * cov.drugindex_match_rate)} unit="%"
              note={<>{n0(cov.products_with_drugindex_match)} of {n0(cov.products_total)} products reach the register</>} />
            <Kpi label="Blocked on reference" value={compact(cov.products_awaiting_drugindex)}
              tone="var(--warn)"
              note={<>{n1(100 * cov.catalogue_blocked_on_drugindex)}% — should fall as scraping continues</>} />
            <Kpi label="Genuinely ambiguous" value={compact(cov.products_unclassified - cov.products_awaiting_drugindex)}
              note={<>more reference data will not resolve these</>} />
            <Kpi label="Carrying a class" value={compact(classCoverage.classed)}
              note={<>across {classCoverage.rows.length} therapeutic categories</>} />
            <Kpi label="In review" value={compact(review.length)}
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
              Every figure below measures linkage between records held — none is a percentage of an
              assumed total, which cannot be known from inside the data.
            </div>
          </div>
        </section>

        <hr className="rule" />

        {/* ------------------------------------------------ reference --- */}
        <div className="quality-reference-grid">
          <Section
            className="quality-linkage"
            eyebrow="Reference data"
            title="Field coverage"
            caption="How completely each record type links to the next. Therapeutic class reaches a product only through a matched ingredient, so product coverage is always lower than the ingredient linkage shown here."
            fill
          >
            <LinkageBars items={linkage} tip={tip} />
          </Section>

          <Section
            className="quality-confidence"
            eyebrow="Resolution"
            title="Match confidence"
            caption="Low-confidence cross-source matches are held out of the shortage signal entirely."
            fill
          >
            <ConfidenceArc counts={stats.byMatch} labels={D.matchBand} tip={tip} />
            <div className="tiny dim quality-confidence-note">
              The choice of matching key moves the headline shortage count on its own. Under exact
              name equality it is 1; under this key 2, and 0 once filtered to medicines and devices.
              The key is versioned and every figure derived from it is labelled.
            </div>
          </Section>
        </div>

        {classCoverage.rows.length > 0 && (
          <Section
            className="quality-class"
            eyebrow={`${compact(classCoverage.classed)} products classed`}
            title="Therapeutic class coverage"
            caption={<>
              Reached through the matched active ingredient. Null is a real state, not an error —
              filtering on a class silently drops every unclassed product, so a class breakdown
              must always show what it excludes.
            </>}
          >
            <div className="quality-class-list">
              {classCoverage.rows.map((r) => (
                <button
                  key={r.label}
                  className="quality-class-row"
                  onClick={() => jump({ therapeutic: [D.therapeutic.indexOf(r.label)] })}
                  onMouseMove={(e) => tip.show(e, (
                    <><b>{r.label}</b><br /><span className="num">{n0(r.n)}</span> products</>
                  ))}
                  onMouseLeave={tip.hide}
                >
                  <span className="trunc" style={{ textAlign: 'left' }}>{r.label}</span>
                  <span className="track"><i style={{ width: `${(100 * r.n) / classCoverage.peak}%` }} /></span>
                  <span className="num">{n0(r.n)}</span>
                </button>
              ))}
            </div>
          </Section>
        )}

        <hr className="rule" />

        {/* --------------------------------------------------- queues --- */}
        <div className="quality-queues-grid">
          <Section
            className="quality-backlog"
            eyebrow={`${compact(backlog.length)} products`}
            title="Awaiting reference data"
            actions={
              <button className="btn btn-sm btn-ghost"
                onClick={() => jump({ gaps: [D.gap.indexOf('di_miss')].filter((x) => x >= 0) })}>
                Open all <Icon name="right" size={11} />
              </button>
            }
            caption="Unclassified with no register match and no usable source category. Ordered by how many pharmacies list them, so the highest-value gaps come first."
            flush
            fill
          >
            <table className="tbl">
              <thead>
                <tr><th>Product</th><th className="r" style={{ width: 78 }}>Listed</th></tr>
              </thead>
              <tbody>
                {backlog.slice(0, QUEUE_ROWS).map((i) => (
                  <tr key={P.key[i]} onClick={() => jump({ q: P.name[i] })}>
                    <td className="cell-name">{P.name[i]}</td>
                    <td className="r num">{P.nListed[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            className="quality-review"
            eyebrow="Human adjudication"
            title="Review queue"
            actions={
              <button className="btn btn-sm btn-ghost" onClick={() => jump({ review: 'needs_review' })}>
                Open all <Icon name="right" size={11} />
              </button>
            }
            caption="Doubtful matches and contested classifications, worst first. These are excluded from the shortage signal."
            flush
            fill
          >
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ width: 96 }}>Reason</th>
                  <th className="r" style={{ width: 70 }}>Match</th>
                </tr>
              </thead>
              <tbody>
                {review.slice(0, QUEUE_ROWS).map((i) => (
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
          </Section>
        </div>

        <hr className="rule" />

        {/* ----------------------------------------------- quarantine --- */}
        <Section
          className="quality-quarantine"
          eyebrow="Excluded from network metrics"
          title="Quarantined feeds"
          caption="A feed that never emits an out-of-stock value is not a source at full availability; it is a source that does not report. Counting it as positive evidence is what inflates the unfiltered rate."
        >
          <div className="quality-quarantine-list">
            {quarantined.map((p) => (
              <div key={p.pharmacy_id} className="quality-quarantine-row">
                <b>{p.name}</b>
                <span className="num">{n0(p.listings)}</span>
                <span className="dim">{p.health_detail}</span>
              </div>
            ))}
          </div>
          <div className="tiny dim quality-quarantine-foot">
            Including them would move the headline from{' '}
            <b className="num" style={{ color: 'var(--ink)' }}>{n1(h.in_stock_rate_gated)}%</b> to{' '}
            <b className="num" style={{ color: 'var(--ink)' }}>{n1(h.in_stock_rate_raw)}%</b>, by
            treating {n0(h.not_published)} listings with no stock signal as available.
          </div>
        </Section>
      </div>
    </div>
  );
}
