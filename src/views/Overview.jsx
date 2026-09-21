/**
 * Overview.
 *
 * Reads top to bottom as an argument, not as a wall of tiles: the headline
 * figures and their caveats, then the network shape, then the thing the
 * dashboard exists to surface, then the supporting distributions.
 *
 * Every figure carries its denominator and provenance in the same block as
 * the number.
 */

import { useMemo, useState } from 'react';
import { runFilter, summarise, sourceBreakdown, EMPTY } from '../lib/filters.js';
import { Section, Kpi, Icon, Strip, n0, n1, kes, compact, fmtDate } from '../components/ui.jsx';
import {
  useTip, SourceBars, TypeMix, PriceCurve, CoveragePlot, BandSteps, ConfidenceArc,
} from '../components/charts.jsx';

/**
 * Sensitivity scenarios for the headline availability rate.
 *
 * A single availability number over a mixed panel is not a fact, it is a
 * choice about who counts. Publishing one without showing how it moves is how
 * a scrape artefact gets reported as a market condition, so the scenarios are
 * always on screen rather than hidden behind a footnote.
 *
 * The scenarios are derived from feed behaviour, never from hard-coded shop
 * names: the outlier this month is not the outlier next month.
 */
function scenarios(pharmacies) {
  const present = pharmacies.filter((p) => p.present_in_snapshot);
  const reporting = present.filter((p) => p.publishes_oos);

  const rate = (rows) => {
    const inS = rows.reduce((a, p) => a + p.in_stock, 0);
    const out = rows.reduce((a, p) => a + p.out_of_stock, 0);
    return inS + out ? { pct: (100 * inS) / (inS + out), inS, denom: inS + out } : null;
  };

  // The single feed contributing the most out-of-stock rows. In September that
  // is Garnet, at 27% of listings but 65% of every stockout in the panel.
  const dominant = [...reporting].sort((a, b) => b.out_of_stock - a.out_of_stock)[0];
  const withoutDominant = reporting.filter((p) => p.pharmacy_id !== dominant?.pharmacy_id);

  const all = rate(present.map((p) => ({
    // A non-reporting feed counted "as published" treats every listing it has
    // as available -- which is exactly the inflation being demonstrated.
    in_stock: p.publishes_oos ? p.in_stock : p.listings,
    out_of_stock: p.publishes_oos ? p.out_of_stock : 0,
  })));

  return [
    {
      key: 'reporting',
      label: 'Reporting feeds',
      value: rate(reporting),
      note: `${reporting.length} of ${present.length} sources publish a stock signal`,
    },
    {
      key: 'all',
      label: 'All feeds',
      value: all,
      note: `counts ${present.length - reporting.length} non-reporting feeds as fully available`,
    },
    dominant && withoutDominant.length ? {
      key: 'exdominant',
      label: `Excl. ${dominant.name.split(' ')[0]}`,
      value: rate(withoutDominant),
      note: `${dominant.name} alone is ${Math.round((100 * dominant.out_of_stock)
        / Math.max(1, reporting.reduce((a, p) => a + p.out_of_stock, 0)))}% of all stockouts`,
    } : null,
  ].filter(Boolean);
}

export default function Overview({ store, onNavigate, setFilters }) {
  const { meta, P, D } = store;
  const h = meta.headline;
  const cov = meta.coverage;
  const tip = useTip();

  const all = useMemo(() => runFilter(store, EMPTY, { key: 'oos', dir: 'desc' }).rows, [store]);
  const stats = useMemo(() => summarise(store, all), [store, all]);
  const sources = useMemo(() => sourceBreakdown(store, all), [store, all]);

  const reportable = useMemo(() => all.filter((i) => (
    P.clinical[i] === 1
    && P.nOos[i] >= 2
    && D.matchBand[P.matchBand[i]] !== 'low'
    && D.review[P.review[i]] === 'auto'
  )), [all, P, D]);
  const shortage = reportable.slice(0, 12);
  const clusterCount = useMemo(
    () => reportable.filter((i) => P.nOos[i] >= 3).length,
    [reportable, P],
  );

  const quarantined = meta.pharmacies.filter((p) => p.present_in_snapshot && p.quarantined);
  const absent = meta.pharmacies.filter((p) => !p.present_in_snapshot);
  const snapshotDate = fmtDate(h.snapshot_at);

  const scen = useMemo(() => scenarios(meta.pharmacies), [meta.pharmacies]);
  const [basis, setBasis] = useState('reporting');
  const active = scen.find((s) => s.key === basis) ?? scen[0];

  // James's "widely available" KPI: the products with enough independent
  // in-stock coverage to route a patient to, as distinct from the shortage
  // signal. Clinical first, because a routing pool of face creams is no use.
  const widelyAvailable = useMemo(
    () => all.filter((i) => P.nIn[i] >= 5).sort((a, b) => P.nIn[b] - P.nIn[a]),
    [all, P],
  );
  const widelyClinical = useMemo(
    () => widelyAvailable.filter((i) => P.clinical[i] === 1),
    [widelyAvailable, P],
  );
  const reviewCount = useMemo(
    () => all.reduce((a, i) => a + (D.review[P.review[i]] === 'needs_review' ? 1 : 0), 0),
    [all, D, P],
  );

  const jump = (patch) => { setFilters({ ...EMPTY, ...patch }); onNavigate('catalogue'); };

  return (
    <div className="page overview-page">
      {tip.node}

      <header className="page-head overview-head">
        <div className="overview-title-block">
          <div>
            <div className="eyebrow">Latest snapshot · {snapshotDate}</div>
            <h1 className="h1">Availability overview</h1>
          </div>
          <p className="overview-lede">
            A verified view of observed catalogue availability, with non-reporting feeds
            quarantined from the network rate.
          </p>
        </div>
        <div className="section-actions overview-head-actions">
            <button className="btn btn-sm" onClick={() => onNavigate('sources')}>Sources</button>
            <button className="btn btn-sm" onClick={() => onNavigate('quality')}>Data quality</button>
        </div>
      </header>

      <div className="stack">
        {/* ------------------------------------------------- headline --- */}
        <section className="section overview-pulse">
          <header className="section-head overview-pulse-head">
            <div className="titles">
              <div className="eyebrow">Snapshot pulse</div>
              <h2 className="section-title">What the network is reporting</h2>
            </div>
            <div className="seg overview-sensitivity" role="group" aria-label="Availability basis">
              {scen.map((s) => (
                <button key={s.key} aria-pressed={basis === s.key}
                  onClick={() => setBasis(s.key)}
                  onMouseMove={(e) => tip.show(e, <><b>{s.label}</b><br />{s.note}</>)}
                  onMouseLeave={tip.hide}
                >{s.label}</button>
              ))}
            </div>
          </header>
          <div className="pulse">
            {/* -- the state: one figure, encoded, not eight competing tiles - */}
            <div className="pulse-hero">
              <div className="pulse-figure">
                <span className="pulse-pct num">{n1(active.value?.pct)}<sup>%</sup></span>
                <div className="pulse-figure-meta">
                  <span className="eyebrow">Observed availability</span>
                  <span><b className="num">{n0(active.value?.inS)}</b> of{' '}
                    <b className="num">{n0(active.value?.denom)}</b> rated listings</span>
                  <span className="dim">{active.note}</span>
                </div>
              </div>

              {/* Composition of the whole panel. The bar IS the headline: how
                  much of the catalogue is actually rated, and how the rated
                  part splits. */}
              <div className="pulse-bar" role="img"
                aria-label={`${n0(h.in_stock)} in stock, ${n0(h.out_of_stock)} out of stock, ${n0(h.not_published)} unrated`}>
                {[
                  ['in', h.in_stock, 'In stock', 'var(--in)'],
                  ['out', h.out_of_stock, 'Out of stock', 'var(--out)'],
                  ['nosig', h.not_published, 'No stock signal', 'var(--nosig)'],
                ].map(([k, v, label, tone]) => (
                  <div key={k} className={`pulse-seg pulse-seg-${k}`}
                    style={{ flexGrow: v, background: k === 'nosig' ? undefined : tone }}
                    onMouseMove={(e) => tip.show(e, (
                      <><b>{label}</b><br /><span className="num">{n0(v)}</span> listings ·{' '}
                        {n1((100 * v) / h.listings)}% of the panel</>
                    ))}
                    onMouseLeave={tip.hide}
                  />
                ))}
              </div>
              <div className="pulse-legend">
                {[
                  ['In stock', h.in_stock, 'var(--in)'],
                  ['Out of stock', h.out_of_stock, 'var(--out)'],
                  ['No stock signal', h.not_published, 'var(--nosig)'],
                ].map(([label, v, tone]) => (
                  <span key={label}>
                    <i style={{ background: tone }} />{label}
                    <b className="num">{compact(v)}</b>
                  </span>
                ))}
              </div>

              {/* The sensitivity spread, shown rather than asserted: you can
                  see how far the headline moves depending on who counts. */}
              <div className="pulse-scale">
                <span className="eyebrow">Spread across bases</span>
                <div className="pulse-scale-track">
                  {scen.map((s) => {
                    const lo = Math.min(...scen.map((x) => x.value?.pct ?? 0)) - 6;
                    const hi = Math.max(...scen.map((x) => x.value?.pct ?? 0)) + 6;
                    const at = (100 * ((s.value?.pct ?? 0) - lo)) / Math.max(1, hi - lo);
                    return (
                      <button key={s.key} className="pulse-tick" data-on={basis === s.key}
                        style={{ left: `${at}%` }}
                        onClick={() => setBasis(s.key)}
                        onMouseMove={(e) => tip.show(e, <><b>{s.label}</b><br />{s.note}</>)}
                        onMouseLeave={tip.hide}
                      >
                        <i />
                        <em className="num">{n1(s.value?.pct)}</em>
                        <span>{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* -- what it is made of ------------------------------------- */}
            <dl className="pulse-list">
              <div className="pulse-list-head"><span className="eyebrow">Panel composition</span></div>
              <div><dt>Resolved products</dt><dd className="num">{compact(h.products)}</dd></div>
              <div><dt>Catalogue listings</dt><dd className="num">{n0(h.listings)}</dd></div>
              <div><dt>Sources reporting</dt>
                <dd className="num">{h.pharmacies_publishing_oos}<span className="faint">/{h.pharmacies}</span></dd></div>
              <div><dt>Median price</dt>
                <dd className="num">{n0(h.median_price_kes)}<span className="faint"> KES</span></dd></div>
              <div><dt>Widely available</dt><dd className="num">{n0(widelyAvailable.length)}</dd></div>
            </dl>

            {/* -- what needs attention ----------------------------------- */}
            <dl className="pulse-list pulse-list-alert">
              <div className="pulse-list-head"><span className="eyebrow">Needs attention</span></div>
              <button onClick={() => jump({ clinicalOnly: true, oosMin: 2 })}>
                <dt>Clinical stockouts</dt><dd className="num">{n0(reportable.length)}</dd>
              </button>
              <button onClick={() => onNavigate('quality')}>
                <dt>Unrated listings</dt><dd className="num">{compact(h.not_published)}</dd>
              </button>
              <button onClick={() => onNavigate('quality')}>
                <dt>Awaiting reference</dt><dd className="num">{compact(cov.products_awaiting_drugindex)}</dd>
              </button>
              <button onClick={() => jump({ review: 'needs_review' })}>
                <dt>In review</dt><dd className="num">{compact(reviewCount)}</dd>
              </button>
              <button onClick={() => onNavigate('sources')}>
                <dt>Sources absent</dt><dd className="num">{absent.length}</dd>
              </button>
            </dl>
          </div>

          <div className="provenance overview-provenance">
            <Icon name="info" size={11} />
            <span>Snapshot <b style={{ color: 'var(--ink-2)' }}>{meta.run.snapshot_id}</b></span>
            <span className="sep">·</span>
            <span>{snapshotDate}{meta.run.snapshot_at_inferred && ' — inferred from file mtime'}</span>
            <span className="sep">·</span>
            <span>match {meta.run.match_algo_version}</span>
            <span className="sep">·</span>
            <span>classifier {meta.run.classifier_version}</span>
            <span className="sep">·</span>
            <span>register {meta.run.drugindex_fingerprint?.slice(0, 8)}</span>
            <span className="sep">·</span>
            <span>contract {meta.contract_version}</span>
          </div>

          {(quarantined.length > 0 || absent.length > 0) && (
            <div className="notice" style={{ marginTop: 12 }}>
              <Icon name="alert" size={13} />
              <div>
                <b>{quarantined.length} feeds publish no out-of-stock signal</b> and are excluded
                from network availability. <b>{absent.length} pharmacies are absent</b> from this
                snapshot — {absent.map((a) => a.name).join(', ')}. Counting non-reporting feeds as
                available would read <span className="num">{n1(h.in_stock_rate_raw)}%</span> instead.
              </div>
            </div>
          )}
        </section>

        <hr className="rule" />

        {/* -------------------------------------------------- network --- */}
        <div className="overview-network-grid">
          <Section
            className="overview-source-section"
            eyebrow="Network signal"
            title="Availability by source"
            actions={<button className="btn btn-sm btn-ghost" onClick={() => onNavigate('sources')}>
              All sources <Icon name="right" size={11} />
            </button>}
            caption="Solid bar is in stock, lighter bar the full catalogue. Hatched sources publish no stock signal, so no rate is derived."
            fill
          >
            <SourceBars rows={sources} tip={tip} onPick={(bit) => jump({ shopsAny: [bit] })} />
          </Section>

          <div className="overview-network-side">
            <Section
              className="overview-type-section"
              eyebrow="Product universe"
              title="Classification mix"
              caption={<>
                <b>{n1(100 * (1 - cov.products_unclassified / h.products))}%</b> classified.
                The reference scrape is unfinished, so this shifts as it completes.
              </>}
            >
              <TypeMix counts={stats.byType} labels={D.type} tip={tip}
                onPick={(i) => jump({ types: [i] })} />
            </Section>

            <Section
              className="overview-band-section"
              eyebrow="Cross-source"
              title="Shortage bands"
              caption="Counted against sources that publish a stock signal — eight of fifteen."
              fill
            >
              <BandSteps counts={stats.byBand} labels={D.band} tip={tip}
                onPick={(i) => jump({ bands: [i] })} />
            </Section>
          </div>
        </div>

        <hr className="rule" />

        {/* ------------------------------------------------- shortage --- */}
        <Section
          className="overview-shortage"
          eyebrow="Clinical shortage signal"
          title="Out of stock across multiple sources"
          actions={
            <button className="btn btn-sm" onClick={() => jump({ clinicalOnly: true, oosMin: 2 })}>
              Open in catalogue <Icon name="right" size={11} />
            </button>
          }
          caption={<>
            Medicines and devices only, confidently matched and not in review.
            <b> No clinical product reaches three sources</b> in this snapshot.
          </>}
          flush
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>Active ingredient</th>
                <th style={{ width: 160 }}>By source</th>
                <th className="r" style={{ width: 78 }}>Out</th>
                <th className="r" style={{ width: 96 }}>Median</th>
              </tr>
            </thead>
            <tbody>
              {shortage.map((i) => (
                <tr key={P.key[i]} onClick={() => jump({ q: P.name[i] })}>
                  <td className="cell-name">{P.name[i]}</td>
                  <td className="cell-name dim tiny">
                    {P.ingredient[i] >= 0 ? D.ingredient[P.ingredient[i]] : '—'}
                  </td>
                  <td>
                    <Strip store={store} listedMask={P.listedMask[i]} inMask={P.inMask[i]}
                      oosMask={P.oosMask[i]}
                      onHover={(e, s, cls) => tip.show(e, <><b>{s.name}</b><br />{
                        cls === 'cell-none' ? 'not listed' : cls === 'cell-out' ? 'out of stock'
                          : cls === 'cell-in' ? 'in stock' : 'no stock signal'}</>)}
                      onLeave={tip.hide} />
                  </td>
                  <td className="r num" style={{ color: 'var(--out)' }}>
                    {P.nOos[i]}<span className="faint">/{P.nEligible[i]}</span>
                  </td>
                  <td className="r num">{Number.isFinite(P.priceMed[i]) ? n0(P.priceMed[i]) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <hr className="rule" />

        {/* ------------------------------------------------ coverage --- */}
        <Section
          className="overview-coverage-table"
          eyebrow={`${n0(widelyClinical.length)} clinical · ${n0(widelyAvailable.length)} overall`}
          title="Broadest in-stock coverage"
          actions={
            <button className="btn btn-sm" onClick={() => jump({ clinicalOnly: true, listedMin: 5 })}>
              Open in catalogue <Icon name="right" size={11} />
            </button>
          }
          caption={<>
            The routing pool: products with enough independent in-stock coverage to send someone
            to. Clinical only — a routing pool of face creams is no use to a patient.
            {widelyClinical.length === 0 && <> <b>Nothing clinical reaches five sources in this snapshot.</b></>}
          </>}
          flush
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>Active ingredient</th>
                <th style={{ width: 160 }}>By source</th>
                <th className="r" style={{ width: 78 }}>In stock</th>
                <th className="r" style={{ width: 96 }}>Median</th>
              </tr>
            </thead>
            <tbody>
              {(widelyClinical.length ? widelyClinical : widelyAvailable).slice(0, 12).map((i) => (
                <tr key={P.key[i]} onClick={() => jump({ q: P.name[i] })}>
                  <td className="cell-name">{P.name[i]}</td>
                  <td className="cell-name dim tiny">
                    {P.ingredient[i] >= 0 ? D.ingredient[P.ingredient[i]] : '—'}
                  </td>
                  <td>
                    <Strip store={store} listedMask={P.listedMask[i]} inMask={P.inMask[i]}
                      oosMask={P.oosMask[i]}
                      onHover={(e, s, cls) => tip.show(e, <><b>{s.name}</b><br />{
                        cls === 'cell-none' ? 'not listed' : cls === 'cell-out' ? 'out of stock'
                          : cls === 'cell-in' ? 'in stock' : 'no stock signal'}</>)}
                      onLeave={tip.hide} />
                  </td>
                  <td className="r num" style={{ color: 'var(--in)' }}>
                    {P.nIn[i]}<span className="faint">/{P.nListed[i]}</span>
                  </td>
                  <td className="r num">{Number.isFinite(P.priceMed[i]) ? n0(P.priceMed[i]) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <hr className="rule" />

        {/* ------------------------------------------------- analysis --- */}
        <div className="overview-analysis-grid">
          <Section className="overview-price-section" eyebrow="Distribution" title="Price" fill
            caption="Log-scaled — retail pharmacy prices span four orders of magnitude. Solid rule is the median, dashed are p10 and p90.">
            <PriceCurve prices={stats.prices} p10={stats.price.p10} p50={stats.price.p50}
              p90={stats.price.p90} tip={tip} height={150} />
          </Section>

          <Section className="overview-coverage-section" eyebrow="Breadth vs availability" title="Coverage" fill
            caption="One mark per listed/in-stock pair, sized by product count. The diagonal is full availability; distance below it is the shortfall.">
            <CoveragePlot store={store} rows={all} tip={tip} height={212}
              onPick={(listed) => jump({ listedMin: listed, listedMax: listed })} />
          </Section>

          <Section className="overview-confidence-section" eyebrow="Resolution" title="Match confidence" fill
            caption={<>Confidence falls with short keys, missing pack size and wide price spread, and recovers when independent sources agree on price.</>}>
            <ConfidenceArc counts={stats.byMatch} labels={D.matchBand} tip={tip} size={150} />
          </Section>
        </div>
      </div>
    </div>
  );
}
