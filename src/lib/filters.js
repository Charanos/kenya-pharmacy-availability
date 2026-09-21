/**
 * Filter engine.
 *
 * One integer pass over the columnar store. Because every categorical column
 * is dictionary-encoded and every per-source question is a bitmask test, a
 * full predicate sweep over 43,606 products costs about a millisecond -- so
 * the UI re-filters, re-counts every facet and redraws every chart on each
 * keystroke, with no debounce and no worker.
 *
 * Facet counts use the standard cross-filter rule: a facet's own dimension is
 * excluded from the predicate used to count it, so the numbers next to each
 * option say "how many you would get if you picked this", not "how many are
 * showing now". Counting them naively is what makes most filter panels feel
 * broken.
 */

import { popcount } from './store.js';

export const EMPTY = {
  q: '',
  types: [],           // dictionary indices
  clinicalOnly: false,
  bands: [],
  matchBands: [],
  review: 'all',       // all | auto | needs_review
  gaps: [],
  forms: [],
  shopsAny: [],        // listed in ANY of these shops (bit positions)
  shopsAll: [],        // listed in ALL of these
  stockIn: [],         // in stock at ANY of these
  stockOut: [],        // out of stock at ANY of these
  listedMin: 0,
  listedMax: 0,
  oosMin: 0,
  oosMax: 0,
  priceMin: null,
  priceMax: null,
  confMin: 0,
  monograph: 'all',    // all | with | without
  contested: false,
  packKinds: [],
  categories: [],      // dictionary indices
  therapeutic: [],     // DrugIndex therapeutic class indices
};

export function isActive(f) {
  return activeChips(f, null).length > 0;
}

const maskOf = (bits) => bits.reduce((m, b) => m | (1 << b), 0);

/**
 * Build one predicate per dimension. Keeping them separate is what lets facet
 * counting drop exactly one dimension without rebuilding everything.
 */
function predicates(store, f) {
  const { P } = store;
  const q = f.q.trim().toLowerCase();
  const anyMask = maskOf(f.shopsAny);
  const allMask = maskOf(f.shopsAll);
  const inMask = maskOf(f.stockIn);
  const outMask = maskOf(f.stockOut);
  const typeSet = f.types.length ? new Set(f.types) : null;
  const bandSet = f.bands.length ? new Set(f.bands) : null;
  const mbSet = f.matchBands.length ? new Set(f.matchBands) : null;
  const gapSet = f.gaps.length ? new Set(f.gaps) : null;
  const formSet = f.forms.length ? new Set(f.forms) : null;
  const packSet = f.packKinds.length ? new Set(f.packKinds) : null;
  const catSet = f.categories.length ? new Set(f.categories) : null;
  const therSet = f.therapeutic.length ? new Set(f.therapeutic) : null;

  return {
    q: q ? (i) => P.nameLower[i].includes(q) || P.ingredientLower[i].includes(q) : null,
    types: typeSet ? (i) => typeSet.has(P.type[i]) : null,
    clinicalOnly: f.clinicalOnly ? (i) => P.clinical[i] === 1 : null,
    bands: bandSet ? (i) => bandSet.has(P.band[i]) : null,
    matchBands: mbSet ? (i) => mbSet.has(P.matchBand[i]) : null,
    review: f.review !== 'all'
      ? (i) => store.D.review[P.review[i]] === f.review : null,
    gaps: gapSet ? (i) => gapSet.has(P.gap[i]) : null,
    forms: formSet ? (i) => formSet.has(P.form[i]) : null,
    shopsAny: anyMask ? (i) => (P.listedMask[i] & anyMask) !== 0 : null,
    shopsAll: allMask ? (i) => (P.listedMask[i] & allMask) === allMask : null,
    stockIn: inMask ? (i) => (P.inMask[i] & inMask) !== 0 : null,
    stockOut: outMask ? (i) => (P.oosMask[i] & outMask) !== 0 : null,
    listed: (f.listedMin || f.listedMax)
      ? (i) => P.nListed[i] >= f.listedMin && (!f.listedMax || P.nListed[i] <= f.listedMax) : null,
    oos: (f.oosMin || f.oosMax)
      ? (i) => P.nOos[i] >= f.oosMin && (!f.oosMax || P.nOos[i] <= f.oosMax) : null,
    price: (f.priceMin != null || f.priceMax != null)
      ? (i) => {
        const v = P.priceMed[i];
        if (!Number.isFinite(v)) return false;
        if (f.priceMin != null && v < f.priceMin) return false;
        if (f.priceMax != null && v > f.priceMax) return false;
        return true;
      } : null,
    conf: f.confMin > 0 ? (i) => P.matchConf[i] >= f.confMin : null,
    monograph: f.monograph !== 'all'
      ? (i) => (f.monograph === 'with' ? P.hasMonograph[i] === 1 : P.hasMonograph[i] === 0) : null,
    contested: f.contested ? (i) => P.contested[i] === 1 : null,
    categories: catSet ? (i) => P.categories[i].some((c) => catSet.has(c)) : null,
    therapeutic: therSet ? (i) => therSet.has(P.therapeutic[i]) : null,
  };
}

/** Indices passing every predicate, optionally ignoring one dimension. */
function sweep(store, preds, skip) {
  const active = Object.entries(preds)
    .filter(([k, fn]) => fn && k !== skip)
    .map(([, fn]) => fn);

  const out = [];
  const n = store.P.n;
  if (!active.length) {
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  outer: for (let i = 0; i < n; i++) {
    for (let p = 0; p < active.length; p++) if (!active[p](i)) continue outer;
    out.push(i);
  }
  return out;
}

const SORTS = {
  relevance: (P) => (a, b) => (P.nOos[b] - P.nOos[a]) || (P.nListed[b] - P.nListed[a]),
  name: (P) => (a, b) => (P.nameLower[a] < P.nameLower[b] ? -1 : P.nameLower[a] > P.nameLower[b] ? 1 : 0),
  listed: (P) => (a, b) => P.nListed[b] - P.nListed[a],
  oos: (P) => (a, b) => P.nOos[b] - P.nOos[a] || P.nListed[b] - P.nListed[a],
  instock: (P) => (a, b) => P.nIn[b] - P.nIn[a],
  oosShare: (P) => (a, b) => (P.oosShare[b] || 0) - (P.oosShare[a] || 0),
  price: (P) => (a, b) => (P.priceMed[b] || -1) - (P.priceMed[a] || -1),
  conf: (P) => (a, b) => P.matchConf[b] - P.matchConf[a],
  listings: (P) => (a, b) => P.listings[b] - P.listings[a],
};

export function runFilter(store, f, sort = { key: 'relevance', dir: 'desc' }) {
  const preds = predicates(store, f);
  const rows = sweep(store, preds, null);

  const cmp = (SORTS[sort.key] ?? SORTS.relevance)(store.P);
  rows.sort(sort.dir === 'asc' ? (a, b) => -cmp(a, b) : cmp);

  return { rows, preds };
}

/**
 * Counts for one facet's options, computed against every OTHER active filter.
 */
export function facetCounts(store, f, dimension, optionCount, valueOf) {
  const preds = predicates(store, f);
  const base = sweep(store, preds, dimension);
  const counts = new Int32Array(optionCount);
  for (const i of base) {
    const v = valueOf(i);
    if (Array.isArray(v)) { for (const x of v) if (x >= 0 && x < optionCount) counts[x]++; }
    else if (v >= 0 && v < optionCount) counts[v]++;
  }
  return counts;
}

/** Per-shop counts for the source facet, from the bitmasks. */
export function shopCounts(store, f, dimension) {
  const preds = predicates(store, f);
  const base = sweep(store, preds, dimension);
  const { P } = store;
  const listed = new Int32Array(store.shops.length);
  const inStock = new Int32Array(store.shops.length);
  const oos = new Int32Array(store.shops.length);
  for (const i of base) {
    const lm = P.listedMask[i]; const im = P.inMask[i]; const om = P.oosMask[i];
    for (let b = 0; b < store.shops.length; b++) {
      const bit = 1 << b;
      if (lm & bit) listed[b]++;
      if (im & bit) inStock[b]++;
      if (om & bit) oos[b]++;
    }
  }
  return { listed, inStock, oos };
}

/** Aggregates over a result set, for the charts above the grid. */
export function summarise(store, rows) {
  const { P } = store;
  const nTypes = store.D.type.length;
  const byType = new Int32Array(nTypes);
  const byBand = new Int32Array(store.D.band.length);
  const byMatch = new Int32Array(store.D.matchBand.length);
  const prices = [];
  let clinical = 0, oosAny = 0, withMono = 0, listedSum = 0, oosSum = 0;

  for (const i of rows) {
    byType[P.type[i]]++;
    byBand[P.band[i]]++;
    byMatch[P.matchBand[i]]++;
    if (P.clinical[i]) clinical++;
    if (P.nOos[i] > 0) oosAny++;
    if (P.hasMonograph[i]) withMono++;
    listedSum += P.nListed[i];
    oosSum += P.nOos[i];
    if (Number.isFinite(P.priceMed[i]) && P.priceMed[i] > 0) prices.push(P.priceMed[i]);
  }
  prices.sort((a, b) => a - b);
  const pick = (p) => (prices.length ? prices[Math.min(prices.length - 1, Math.floor(prices.length * p))] : null);

  return {
    total: rows.length,
    clinical,
    oosAny,
    withMono,
    avgListed: rows.length ? listedSum / rows.length : 0,
    avgOos: rows.length ? oosSum / rows.length : 0,
    byType, byBand, byMatch,
    price: { p10: pick(0.1), p50: pick(0.5), p90: pick(0.9), n: prices.length },
    prices,
  };
}

/** Per-source availability over a result set, for the bar chart. */
export function sourceBreakdown(store, rows) {
  const { P, shops } = store;
  const out = shops.map((s) => ({ shop: s, listed: 0, inStock: 0, oos: 0 }));
  for (const i of rows) {
    const lm = P.listedMask[i]; const im = P.inMask[i]; const om = P.oosMask[i];
    for (let b = 0; b < shops.length; b++) {
      const bit = 1 << b;
      if (lm & bit) out[b].listed++;
      if (im & bit) out[b].inStock++;
      if (om & bit) out[b].oos++;
    }
  }
  for (const r of out) {
    const reporting = r.inStock + r.oos;
    r.rate = reporting ? (100 * r.inStock) / reporting : null;
  }
  return out;
}

/** Human-readable active filters, for the chip row. */
export function activeChips(f, store) {
  const D = store?.D;
  const chips = [];
  const add = (key, label, clear) => chips.push({ key, label, clear });

  if (f.q.trim()) add('q', `"${f.q.trim()}"`, { q: '' });
  if (f.clinicalOnly) add('clinicalOnly', 'Medicines & devices', { clinicalOnly: false });
  for (const t of f.types) add(`type:${t}`, D ? D.type[t] : `type ${t}`, { types: f.types.filter((x) => x !== t) });
  for (const b of f.bands) add(`band:${b}`, D ? `band: ${D.band[b]}` : `band ${b}`, { bands: f.bands.filter((x) => x !== b) });
  for (const m of f.matchBands) add(`mb:${m}`, D ? `match: ${D.matchBand[m]}` : `${m}`, { matchBands: f.matchBands.filter((x) => x !== m) });
  for (const g of f.gaps) add(`gap:${g}`, D ? `gap: ${D.gap[g]}` : `${g}`, { gaps: f.gaps.filter((x) => x !== g) });
  for (const fo of f.forms) add(`form:${fo}`, D ? D.form[fo] : `${fo}`, { forms: f.forms.filter((x) => x !== fo) });
  for (const c of f.categories) add(`cat:${c}`, D ? D.category[c] : `${c}`, { categories: f.categories.filter((x) => x !== c) });
  for (const t of f.therapeutic) add(`tx:${t}`, D ? D.therapeutic[t] : `${t}`, { therapeutic: f.therapeutic.filter((x) => x !== t) });
  if (f.review !== 'all') add('review', f.review === 'auto' ? 'Trusted' : 'Needs review', { review: 'all' });
  if (f.monograph !== 'all') add('mono', f.monograph === 'with' ? 'Has monograph' : 'No monograph', { monograph: 'all' });
  if (f.contested) add('contested', 'Contested class', { contested: false });
  for (const s of f.shopsAny) add(`any:${s}`, `in ${store?.shops[s]?.name ?? s}`, { shopsAny: f.shopsAny.filter((x) => x !== s) });
  for (const s of f.shopsAll) add(`all:${s}`, `all of ${store?.shops[s]?.name ?? s}`, { shopsAll: f.shopsAll.filter((x) => x !== s) });
  for (const s of f.stockIn) add(`in:${s}`, `in stock @ ${store?.shops[s]?.name ?? s}`, { stockIn: f.stockIn.filter((x) => x !== s) });
  for (const s of f.stockOut) add(`out:${s}`, `out @ ${store?.shops[s]?.name ?? s}`, { stockOut: f.stockOut.filter((x) => x !== s) });
  if (f.listedMin || f.listedMax) add('listed', `listed ${f.listedMin || 0}–${f.listedMax || '∞'}`, { listedMin: 0, listedMax: 0 });
  if (f.oosMin || f.oosMax) add('oos', `OOS ${f.oosMin || 0}–${f.oosMax || '∞'}`, { oosMin: 0, oosMax: 0 });
  if (f.priceMin != null || f.priceMax != null) {
    add('price', `KES ${f.priceMin ?? 0}–${f.priceMax ?? '∞'}`, { priceMin: null, priceMax: null });
  }
  if (f.confMin > 0) add('conf', `confidence ≥ ${f.confMin}`, { confMin: 0 });
  return chips;
}

/* ------------------------------------------------------------- URL state */

const SHORT = {
  q: 'q', types: 't', clinicalOnly: 'cl', bands: 'b', matchBands: 'mb', review: 'rv',
  gaps: 'g', forms: 'fm', shopsAny: 'sa', shopsAll: 'sl', stockIn: 'si', stockOut: 'so',
  listedMin: 'lmin', listedMax: 'lmax', oosMin: 'omin', oosMax: 'omax',
  priceMin: 'pmin', priceMax: 'pmax', confMin: 'cf', monograph: 'mo',
  contested: 'ct', packKinds: 'pk', categories: 'cat', therapeutic: 'tx',
};

export function encodeFilters(f) {
  const p = new URLSearchParams();
  for (const [key, short] of Object.entries(SHORT)) {
    const v = f[key];
    const d = EMPTY[key];
    if (Array.isArray(v)) { if (v.length) p.set(short, v.join('.')); }
    else if (typeof v === 'boolean') { if (v !== d) p.set(short, '1'); }
    else if (v !== d && v !== null && v !== '') p.set(short, String(v));
  }
  return p;
}

export function decodeFilters(params) {
  const f = { ...EMPTY };
  for (const [key, short] of Object.entries(SHORT)) {
    if (!params.has(short)) continue;
    const raw = params.get(short);
    const d = EMPTY[key];
    if (Array.isArray(d)) f[key] = raw.split('.').filter(Boolean).map(Number);
    else if (typeof d === 'boolean') f[key] = raw === '1';
    else if (typeof d === 'number') f[key] = Number(raw);
    else if (d === null) f[key] = raw === '' ? null : Number(raw);
    else f[key] = raw;
  }
  return f;
}
