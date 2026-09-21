/**
 * Charts.
 *
 * Hand-built SVG rather than a charting library, because the library defaults
 * -- rounded bars, auto legends, stock palettes, drop shadows -- are precisely
 * the generic look this is meant to avoid. Every mark here is a deliberate
 * choice, and each chart answers a different question: nothing is repeated in
 * a new colour.
 *
 *   SourceBars      availability per pharmacy, hatched where no signal exists
 *   TypeMix         one proportional bar, not a donut
 *   PriceCurve      log-scaled price distribution with quantile rules
 *   CoveragePlot    breadth vs availability, one dot per product
 *   Matrix          products x pharmacies heatmap -- the signature view
 *   BandSteps       shortage cluster bands, lollipop
 *   LinkageBars     DrugIndex field coverage
 *   ConfidenceArc   match confidence split
 */

import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Render charts at their true pixel width instead of scaling a fixed viewBox.
 *
 * Stretching a viewBox to fit is the easy path and it distorts every label in
 * the chart — a 560-unit box squeezed into a 290px card halves the type
 * horizontally. Measuring means axis text stays the same size everywhere on
 * the page, which is the difference between a chart that looks drawn and one
 * that looks resized.
 */
export function useMeasure() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/* ----------------------------------------------------------- tooltip ---- */

export function useTip() {
  const [tip, setTip] = useState(null);
  const show = useCallback((e, content) => {
    setTip({ x: e.clientX, y: e.clientY, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div
      className="tip"
      style={{
        left: Math.min(tip.x + 14, window.innerWidth - 300),
        top: Math.max(8, tip.y - 12),
      }}
    >
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}

const fmt = new Intl.NumberFormat('en-KE');
const n0 = (v) => fmt.format(Math.round(v ?? 0));

/* -------------------------------------------------- availability bars --- */

export function SourceBars({ rows, tip, onPick, selected }) {
  const max = Math.max(1, ...rows.map((r) => r.listed));
  return (
    <div className="barlist">
      {rows.map((r) => {
        const reports = r.shop.publishes_oos;
        const w = (100 * r.listed) / max;
        const on = selected?.includes(r.shop.bit);
        return (
          <div
            className="barrow"
            key={r.shop.pharmacy_id}
            style={{ cursor: onPick ? 'pointer' : 'default', opacity: on === false && selected?.length ? 0.45 : 1 }}
            onClick={() => onPick?.(r.shop.bit)}
            onMouseMove={(e) => tip.show(e, (
              <>
                <b>{r.shop.name}</b><br />
                {n0(r.listed)} listed
                {reports ? (
                  <> · <span className="num">{n0(r.inStock)}</span> in stock · <span className="num">{n0(r.oos)}</span> out</>
                ) : <> · publishes no stock signal</>}
                <br />
                <span className="dim">{r.shop.platform}</span>
              </>
            ))}
            onMouseLeave={tip.hide}
          >
            <div className="barrow-label" style={{ color: on ? 'var(--accent)' : undefined, fontWeight: on ? 600 : 400 }}>
              {r.shop.name}
            </div>
            <div className="bartrack">
              {reports ? (
                <>
                  <div
                    className="barfill"
                    style={{
                      width: `${w}%`,
                      background: 'var(--ramp-2)',
                      position: 'absolute', inset: 0,
                    }}
                  />
                  <div
                    className="barfill"
                    style={{
                      width: `${(100 * r.inStock) / max}%`,
                      background: 'var(--ramp-5)',
                      position: 'absolute', inset: 0,
                    }}
                  />
                </>
              ) : (
                <div className="barfill hatched" style={{ width: `${w}%` }} />
              )}
            </div>
            <div className="barval" style={{ color: reports ? 'var(--ink)' : 'var(--ink-4)' }}>
              {reports ? `${r.rate == null ? '—' : r.rate.toFixed(1)}%` : '—'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ type mix -- */

const TYPE_TONE = {
  medicine: 'var(--ramp-5)',
  device: 'var(--ramp-4)',
  supplement: 'var(--ramp-3)',
  cosmetic: 'var(--ramp-2)',
  personal_care: 'var(--ramp-2)',
  food: 'var(--ramp-1)',
  sexual_wellness: 'var(--ramp-1)',
  unclassified: 'var(--line-strong)',
};

export function TypeMix({ counts, labels, tip, onPick, selected }) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const order = labels
    .map((label, i) => ({ label, i, n: counts[i] ?? 0 }))
    .filter((d) => d.n > 0)
    .sort((a, b) => b.n - a.n);

  return (
    <div>
      <div style={{ display: 'flex', height: 34, borderRadius: 5, overflow: 'hidden', gap: 2 }}>
        {order.map((d) => (
          <div
            key={d.label}
            className="mark"
            style={{
              width: `${(100 * d.n) / total}%`,
              background: TYPE_TONE[d.label] ?? 'var(--ramp-2)',
              cursor: 'pointer',
              outline: selected?.includes(d.i) ? '2px solid var(--ink)' : 'none',
              outlineOffset: -2,
            }}
            onClick={() => onPick?.(d.i)}
            onMouseMove={(e) => tip.show(e, (
              <><b>{d.label.replace(/_/g, ' ')}</b><br />
                <span className="num">{n0(d.n)}</span> products · {((100 * d.n) / total).toFixed(1)}%</>
            ))}
            onMouseLeave={tip.hide}
          />
        ))}
      </div>

      {/* A two-column grid rather than a wrapping row: the counts line up in a
          reading column instead of scattering wherever the labels happen to
          break, which is what makes a legend look thrown together. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        columnGap: 18, rowGap: 7, marginTop: 16,
      }}>
        {order.map((d) => (
          <button
            key={d.label}
            onClick={() => onPick?.(d.i)}
            style={{
              display: 'grid', gridTemplateColumns: '9px 1fr auto',
              alignItems: 'center', gap: 8, textAlign: 'left', fontSize: 11.5,
              color: selected?.includes(d.i) ? 'var(--ink)' : 'var(--ink-2)',
              fontWeight: selected?.includes(d.i) ? 500 : 400,
            }}
            onMouseMove={(e) => tip.show(e, (
              <><b>{d.label.replace(/_/g, ' ')}</b><br />
                <span className="num">{n0(d.n)}</span> · {((100 * d.n) / total).toFixed(1)}%</>
            ))}
            onMouseLeave={tip.hide}
          >
            <i style={{
              width: 9, height: 9, borderRadius: 2, display: 'block',
              background: TYPE_TONE[d.label] ?? 'var(--ramp-2)',
            }} />
            <span className="trunc">{d.label.replace(/_/g, ' ')}</span>
            <span className="num" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>{n0(d.n)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- price curve --- */

/**
 * Log-scaled, because retail pharmacy prices span four orders of magnitude and
 * linear buckets put 90% of the catalogue in the first bar.
 */
export function PriceCurve({ prices, p10, p50, p90, tip, height = 120 }) {
  const [ref, measured] = useMeasure();
  if (!prices?.length) {
    return <div ref={ref} className="empty tiny">No priced products in this selection</div>;
  }

  const W = measured || 520; const H = height; const pad = { l: 4, r: 4, t: 14, b: 20 };
  const lo = Math.log10(Math.max(1, prices[0]));
  const hi = Math.log10(Math.max(10, prices[prices.length - 1]));
  const span = Math.max(0.5, hi - lo);
  const BUCKETS = 56;
  const bins = new Int32Array(BUCKETS);
  for (const v of prices) {
    if (v <= 0) continue;
    const t = (Math.log10(v) - lo) / span;
    bins[Math.min(BUCKETS - 1, Math.max(0, Math.floor(t * BUCKETS)))]++;
  }
  const peak = Math.max(1, ...bins);
  const bw = (W - pad.l - pad.r) / BUCKETS;
  const xOf = (v) => pad.l + ((Math.log10(Math.max(1, v)) - lo) / span) * (W - pad.l - pad.r);

  const ticks = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    const v = 10 ** e;
    if (v >= 1 && Math.log10(v) >= lo && Math.log10(v) <= hi) ticks.push(v);
  }

  return (
    <div ref={ref} style={{ width: '100%' }}>
    <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {/* Array.from is load-bearing: bins is an Int32Array, and a typed
          array's map() coerces whatever the callback returns back to a
          number, so mapping straight to <rect> yielded NaN and the
          histogram rendered as an empty axis. */}
      {Array.from(bins).map((n, i) => {
        const h = (n / peak) * (H - pad.t - pad.b);
        return (
          <rect
            key={i} className="mark"
            x={pad.l + i * bw} y={H - pad.b - h}
            width={Math.max(0.5, bw - 1)} height={h}
            fill="var(--ramp-3)"
            onMouseMove={(e) => tip.show(e, (
              <>~KES <span className="num">{n0(10 ** (lo + ((i + 0.5) / BUCKETS) * span))}</span><br />
                <span className="num">{n0(n)}</span> products</>
            ))}
            onMouseLeave={tip.hide}
          />
        );
      })}
      {[['p10', p10], ['median', p50], ['p90', p90]].map(([label, v]) => v ? (
        <g key={label}>
          <line x1={xOf(v)} x2={xOf(v)} y1={pad.t - 4} y2={H - pad.b}
            stroke={label === 'median' ? 'var(--ink)' : 'var(--ink-4)'}
            strokeWidth={label === 'median' ? 1.25 : 1}
            strokeDasharray={label === 'median' ? '' : '2 2'} />
          <text x={xOf(v)} y={pad.t - 6} textAnchor="middle" className="tnum"
            style={{ fontSize: 9, fill: label === 'median' ? 'var(--ink-2)' : 'var(--ink-4)' }}>
            {label === 'median' ? `KES ${n0(v)}` : ''}
          </text>
        </g>
      ) : null)}
      {ticks.map((v) => (
        <text key={v} x={xOf(v)} y={H - 5} textAnchor="middle" className="tnum" style={{ fontSize: 9 }}>
          {v >= 1000 ? `${v / 1000}k` : v}
        </text>
      ))}
    </svg>
    </div>
  );
}

/* ------------------------------------------------------ coverage plot --- */

/**
 * Breadth (how many pharmacies list it) against availability (how many have it
 * in stock). Everything on the diagonal is fully available; distance below the
 * diagonal is the shortage. Jittered because the values are small integers and
 * would otherwise stack into 15 invisible points.
 */
export function CoveragePlot({ store, rows, tip, onPick, height = 250 }) {
  const { P } = store;
  const [ref, measured] = useMeasure();
  // Bottom padding carries two stacked rows — tick numbers then the axis
  // title — so they need separate bands or they collide.
  const W = measured || 400; const H = height; const pad = { l: 30, r: 12, t: 12, b: 36 };

  // Bucket into a grid so 43,606 dots become at most a few dozen sized marks.
  const cells = new Map();
  let observedMax = 0;
  for (const i of rows) {
    const k = P.nListed[i] * 64 + P.nIn[i];
    if (P.nListed[i] > observedMax) observedMax = P.nListed[i];
    const c = cells.get(k);
    if (c) c.n++;
    else cells.set(k, { listed: P.nListed[i], inStock: P.nIn[i], n: 1, sample: i });
  }
  const all = [...cells.values()];
  const peak = Math.max(1, ...all.map((c) => c.n));

  // Scale to the data, not to the 15-source ceiling. Nothing is listed in
  // more than a handful of catalogues, so a fixed domain spends two thirds of
  // the plot on empty space.
  const maxN = Math.max(2, observedMax);
  const x = (v) => pad.l + (v / maxN) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / maxN) * (H - pad.t - pad.b);
  const step = maxN <= 6 ? 1 : maxN <= 12 ? 2 : 5;
  const ticks = [];
  for (let v = 0; v <= maxN; v += step) ticks.push(v);

  return (
    <div ref={ref} style={{ width: '100%' }}>
    <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <line className="gridline" x1={x(0)} y1={y(0)} x2={x(maxN)} y2={y(maxN)} strokeDasharray="3 3" />
      {ticks.map((v) => (
        <g key={v}>
          <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" className="tnum">{v}</text>
          <text x={x(v)} y={H - pad.b + 15} textAnchor="middle" className="tnum">{v}</text>
        </g>
      ))}
      {all.sort((a, b) => a.n - b.n).map((c) => {
        const r = 1.6 + Math.sqrt(c.n / peak) * 8;
        const short = c.listed - c.inStock;
        return (
          <circle
            key={`${c.listed}-${c.inStock}`} className="mark"
            cx={x(c.listed)} cy={y(c.inStock)} r={r}
            fill={short === 0 ? 'var(--in)' : short >= 3 ? 'var(--out)' : 'var(--ramp-4)'}
            fillOpacity={0.45} stroke="var(--surface)" strokeWidth={0.5}
            style={{ cursor: 'pointer' }}
            onClick={() => onPick?.(c.listed)}
            onMouseMove={(e) => tip.show(e, (
              <>Listed in <b>{c.listed}</b>, in stock at <b>{c.inStock}</b><br />
                <span className="num">{n0(c.n)}</span> products</>
            ))}
            onMouseLeave={tip.hide}
          />
        );
      })}
      <text x={(pad.l + W - pad.r) / 2} y={H - 4} textAnchor="middle" style={{ fontSize: 9.5 }}>
        pharmacies listing
      </text>
      <text transform={`rotate(-90) translate(${-(pad.t + H - pad.b) / 2} 10)`} textAnchor="middle"
        style={{ fontSize: 9.5 }}>in stock</text>
    </svg>
    </div>
  );
}

/* ------------------------------------------------------------- matrix --- */

/**
 * The signature view: products down, pharmacies across, one cell per pair.
 * Reads the bitmasks directly, so it costs nothing to redraw as filters change.
 */
export function Matrix({ store, rows, limit = 40, tip, onPick }) {
  const { P, shops } = store;
  const slice = rows.slice(0, limit);
  const colW = 22;
  const labelW = 210;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: labelW + shops.length * colW + 60 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', height: 74, paddingLeft: labelW, gap: 0 }}>
          {shops.map((s) => (
            <div key={s.pharmacy_id} style={{ width: colW, position: 'relative' }}>
              <div style={{
                position: 'absolute', bottom: 4, left: '50%',
                transformOrigin: 'left bottom', transform: 'rotate(-58deg)',
                fontSize: 10, whiteSpace: 'nowrap',
                color: s.publishes_oos ? 'var(--ink-2)' : 'var(--ink-4)',
              }}>
                {s.name}{!s.publishes_oos && ' *'}
              </div>
            </div>
          ))}
        </div>
        {slice.map((i) => (
          <div
            key={P.key[i]}
            style={{ display: 'flex', alignItems: 'center', height: 20, cursor: 'pointer' }}
            onClick={() => onPick?.(i)}
            className="matrix-row"
          >
            <div className="trunc" style={{ width: labelW, paddingRight: 10, fontSize: 11.5 }}>
              {P.name[i]}
            </div>
            {shops.map((s) => {
              const bit = 1 << s.bit;
              const listed = P.listedMask[i] & bit;
              const inS = P.inMask[i] & bit;
              const out = P.oosMask[i] & bit;
              const cls = !listed ? 'cell-none' : out ? 'cell-out' : inS ? 'cell-in' : 'cell-nosig';
              return (
                <div key={s.pharmacy_id} style={{ width: colW, display: 'grid', placeItems: 'center' }}>
                  <div
                    className={cls}
                    style={{ width: colW - 4, height: 15, borderRadius: 1.5 }}
                    onMouseMove={(e) => tip.show(e, (
                      <><b>{P.name[i]}</b><br />{s.name}: {
                        !listed ? 'not listed' : out ? 'out of stock' : inS ? 'in stock' : 'no stock signal'
                      }</>
                    ))}
                    onMouseLeave={tip.hide}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- band steps --- */

/**
 * Cluster bands as a lollipop scale.
 *
 * Every band is drawn even when empty. The empty ones are the finding — that
 * nothing in this snapshot reaches `systemic` or beyond is the headline, and
 * hiding those rows would quietly turn a three-rung ladder into the whole
 * scale and make a 3-of-15 cluster look like the top of the range.
 */
export function BandSteps({ counts, labels, tip, onPick, selected }) {
  const ORDER = [
    ['isolated', '1'], ['local', '2'], ['cluster', '3–4'],
    ['systemic', '5–9'], ['national', '10–14'], ['total', '15+'],
  ];
  const data = ORDER.map(([name, range]) => {
    const i = labels.indexOf(name);
    return { name, range, i, n: i >= 0 ? (counts[i] ?? 0) : 0 };
  });
  const max = Math.max(1, ...data.map((d) => d.n));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {data.map((d) => {
        const w = (100 * d.n) / max;
        const dim = d.n === 0;
        return (
          <button
            key={d.name}
            onClick={() => d.i >= 0 && d.n > 0 && onPick?.(d.i)}
            disabled={dim}
            style={{
              display: 'grid', gridTemplateColumns: '62px 30px 1fr 52px',
              alignItems: 'center', gap: 8, padding: '3px 0', textAlign: 'left',
              opacity: selected?.length && d.i >= 0 && !selected.includes(d.i) ? 0.35 : 1,
              cursor: dim ? 'default' : 'pointer',
            }}
            onMouseMove={(e) => tip.show(e, (
              <><b>{d.name}</b> · out of stock in {d.range} source{d.range === '1' ? '' : 's'}<br />
                <span className="num">{n0(d.n)}</span> products</>
            ))}
            onMouseLeave={tip.hide}
          >
            <span style={{ fontSize: 11, color: dim ? 'var(--ink-4)' : 'var(--ink-2)' }}>{d.name}</span>
            <span className="num" style={{ fontSize: 9.5, color: 'var(--ink-4)' }}>{d.range}</span>
            <span style={{ position: 'relative', height: 3, background: 'var(--line-faint)', borderRadius: 2 }}>
              <span style={{
                position: 'absolute', inset: 0, width: `${w}%`,
                background: d.n ? 'var(--ramp-4)' : 'transparent', borderRadius: 2,
                transition: 'width .35s cubic-bezier(.4,0,.2,1)',
              }} />
              {d.n > 0 && (
                <span style={{
                  position: 'absolute', left: `calc(${w}% - 3.5px)`, top: -2.5,
                  width: 7, height: 7, borderRadius: '50%', background: 'var(--ramp-5)',
                }} />
              )}
            </span>
            <span className="num" style={{
              fontSize: 11, textAlign: 'right', color: dim ? 'var(--ink-4)' : undefined,
            }}>{d.n ? n0(d.n) : '—'}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- linkage bars --- */

export function LinkageBars({ items, tip }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {items.map((it) => (
        <div key={it.label}
          onMouseMove={(e) => tip?.show(e, <><b>{it.label}</b><br />{it.note}</>)}
          onMouseLeave={() => tip?.hide()}
        >
          <div className="row" style={{ marginBottom: 3 }}>
            <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{it.label}</span>
            <span className="spacer num" style={{ fontSize: 11 }}>
              {it.value == null ? '—' : `${(100 * it.value).toFixed(0)}%`}
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--surface-sunk)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${100 * (it.value ?? 0)}%`,
              background: it.value === 0 ? 'var(--out)' : it.value < 0.5 ? 'var(--warn)' : 'var(--ramp-4)',
              borderRadius: 2, transition: 'width .4s cubic-bezier(.4,0,.2,1)',
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------- confidence arc --- */

/**
 * A gauge rather than a donut: the question is "how much of the catalogue is
 * confidently resolved", which is a single proportion read against a full
 * sweep, not a part-to-part comparison. The dominant share gets a readable
 * figure in the well instead of forcing a trip to the legend.
 */
export function ConfidenceArc({ counts, labels, tip, size }) {
  const [ref, measured] = useMeasure();
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const TONE = { high: 'var(--ramp-5)', medium: 'var(--ramp-3)', low: 'var(--warn)' };

  const W = Math.max(160, Math.min(measured || size || 260, 320));
  const R = W / 2 - 16;
  const C = W / 2;
  const H = C + 14;
  const circ = Math.PI * R;
  const stroke = Math.max(12, Math.round(R * 0.22));
  let offset = 0;

  const top = labels
    .map((label, i) => ({ label, n: counts[i] ?? 0 }))
    .sort((a, b) => b.n - a.n)[0];

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ margin: '0 auto' }}>
        <path d={`M ${C - R} ${C} A ${R} ${R} 0 0 1 ${C + R} ${C}`}
          fill="none" stroke="var(--surface-sunk)" strokeWidth={stroke} strokeLinecap="butt" />
        {labels.map((label, i) => {
          const n = counts[i] ?? 0;
          if (!n) return null;
          const len = (n / total) * circ;
          const el = (
            <path key={label}
              d={`M ${C - R} ${C} A ${R} ${R} 0 0 1 ${C + R} ${C}`}
              fill="none" stroke={TONE[label] ?? 'var(--ramp-2)'} strokeWidth={stroke}
              strokeDasharray={`${len} ${circ}`} strokeDashoffset={-offset}
              className="mark"
              onMouseMove={(e) => tip.show(e, (
                <><b>{label}</b> confidence<br />
                  <span className="num">{n0(n)}</span> · {((100 * n) / total).toFixed(1)}%</>
              ))}
              onMouseLeave={tip.hide}
            />
          );
          offset += len;
          return el;
        })}
        <text x={C} y={C - 8} textAnchor="middle" className="tnum"
          style={{ fontSize: 23, fill: 'var(--ink)', letterSpacing: '-0.03em' }}>
          {((100 * top.n) / total).toFixed(1)}%
        </text>
        <text x={C} y={C + 7} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--ink-3)' }}>
          {top.label} confidence
        </text>
      </svg>

      <div style={{
        display: 'flex', justifyContent: 'center', flexWrap: 'wrap',
        gap: '4px 16px', marginTop: 10,
      }}>
        {labels.map((label, i) => (counts[i] ? (
          <span key={label} className="row" style={{ fontSize: 11, gap: 6 }}>
            <i style={{
              width: 8, height: 8, borderRadius: 2, display: 'block',
              background: TONE[label] ?? 'var(--ramp-2)',
            }} />
            <span style={{ color: 'var(--ink-2)' }}>{label}</span>
            <span className="num faint">{n0(counts[i])}</span>
          </span>
        ) : null))}
      </div>
    </div>
  );
}
