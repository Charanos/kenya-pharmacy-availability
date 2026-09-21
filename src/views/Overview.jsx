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

import { useMemo } from 'react';
import { runFilter, summarise, sourceBreakdown, EMPTY } from '../lib/filters.js';
import { Section, Kpi, Icon, Strip, n0, n1, kes, compact, fmtDate } from '../components/ui.jsx';
import {
  useTip, SourceBars, TypeMix, PriceCurve, CoveragePlot, BandSteps, ConfidenceArc,
} from '../components/charts.jsx';

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
            <span className="overview-pulse-asof">as at {snapshotDate}</span>
          </header>
          <div className="kpis">
            <Kpi label="Availability" value={n1(h.in_stock_rate_gated)} unit="%"
              note={<><b>{n0(h.in_stock)}</b> of {n0(h.in_stock + h.out_of_stock)} reporting listings</>} />
            <Kpi label="Reporting sources" value={`${h.pharmacies_publishing_oos}/${h.pharmacies}`}
              note={<>{h.pharmacies - h.pharmacies_publishing_oos} publish no stock signal</>} />
            <Kpi label="Products" value={compact(h.products)}
              note={<>resolved from {n0(h.listings)} listings</>} />
            <Kpi label="Clinical stockouts" value={n0(reportable.length)}
              tone={reportable.length ? 'var(--out)' : undefined}
              note={<>in ≥2 sources · <b>{clusterCount}</b> reach three</>} />
            <Kpi label="Median price" value={n0(h.median_price_kes)} unit="KES"
              note={<>across {compact(stats.price.n)} priced products</>} />
            <Kpi label="Awaiting reference" value={compact(cov.products_awaiting_drugindex)}
              tone="var(--warn)"
              note={<>{n1(100 * cov.catalogue_blocked_on_drugindex)}% of catalogue unclassified</>} />
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
