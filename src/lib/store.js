/**
 * Columnar data store.
 *
 * meta.json (50 KB) lands first so the shell and every headline figure paint
 * immediately. products.json (1.5 MB gzipped) follows for the grid, and
 * listings.json is fetched only when a screen actually needs per-source rows.
 *
 * Columns arrive as plain arrays and are promoted to typed arrays on load.
 * Filtering then runs as a single pass of integer comparisons over 43,606
 * entries, which is around a millisecond -- fast enough that every keystroke
 * can re-filter, re-count every facet and redraw every chart without
 * debouncing or a worker.
 */

const BASE = 'app';

async function getJson(name, onProgress) {
  const res = await fetch(`${BASE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}.json: ${res.status} ${res.statusText}`);
  // Stream so the loader can show real progress on the larger payloads rather
  // than a spinner that sits at zero for two seconds.
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !res.body || !total) return res.json();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const buf = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

const i32 = (a) => Int32Array.from(a, (v) => (v == null ? -1 : v));
const u8 = (a) => Uint8Array.from(a, (v) => (v == null ? 0 : v));
const u16 = (a) => Uint16Array.from(a, (v) => (v == null ? 0 : v));
const f64 = (a) => Float64Array.from(a, (v) => (v == null ? NaN : v));

/** Population count — how many pharmacies a bitmask represents. */
export function popcount(v) {
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  return (((v + (v >> 4)) & 0x0f0f) * 0x0101) >> 8;
}

export async function loadStore(onStage) {
  onStage?.({ stage: 'meta', progress: 0 });
  const meta = await getJson('meta');

  onStage?.({ stage: 'products', progress: 0 });
  const raw = await getJson('products', (p) => onStage?.({ stage: 'products', progress: p }));

  const n = raw.key.length;
  const P = {
    n,
    key: raw.key,
    name: raw.name,
    // Lowercased once at load; search then avoids 43,606 toLowerCase calls per
    // keystroke, which is the difference between 1 ms and 40 ms.
    nameLower: raw.name.map((s) => s.toLowerCase()),
    type: u8(raw.type),
    clinical: u8(raw.clinical),
    form: i32(raw.form),
    packKind: i32(raw.packKind),
    packValue: f64(raw.packValue),
    packSig: raw.packSig,
    strengthValue: f64(raw.strengthValue),
    listings: u16(raw.listings),
    nListed: u8(raw.nListed),
    nEligible: u8(raw.nEligible),
    nOos: u8(raw.nOos),
    nIn: u8(raw.nIn),
    oosShare: f64(raw.oosShare),
    band: u8(raw.band),
    matchConf: f64(raw.matchConf),
    matchBand: u8(raw.matchBand),
    priceCv: f64(raw.priceCv),
    matchFlags: i32(raw.matchFlags),
    review: u8(raw.review),
    gap: i32(raw.gap),
    classConf: f64(raw.classConf),
    contested: u8(raw.contested),
    priceMin: f64(raw.priceMin),
    priceMed: f64(raw.priceMed),
    priceMax: f64(raw.priceMax),
    ingredient: i32(raw.ingredient),
    indications: i32(raw.indications),
    therapeutic: i32(raw.therapeutic),
    hasMonograph: u8(raw.hasMonograph),
    listedMask: u16(raw.listedMask),
    inMask: u16(raw.inMask),
    oosMask: u16(raw.oosMask),
    categories: raw.categories,
  };

  // Ingredient names are searched alongside product names, so resolve the
  // dictionary index to a lowercase string once rather than per query.
  const ingLower = meta.dictionaries.ingredient.map((s) => s.toLowerCase());
  P.ingredientLower = Array.from(P.ingredient, (idx) => (idx >= 0 ? ingLower[idx] : ''));

  const dicts = meta.dictionaries;
  const D = {
    ...dicts,
    typeIndex: Object.fromEntries(dicts.type.map((v, i) => [v, i])),
    bandIndex: Object.fromEntries(dicts.band.map((v, i) => [v, i])),
    matchBandIndex: Object.fromEntries(dicts.matchBand.map((v, i) => [v, i])),
    reviewIndex: Object.fromEntries(dicts.review.map((v, i) => [v, i])),
    gapIndex: Object.fromEntries(dicts.gap.map((v, i) => [v, i])),
  };

  const shops = meta.pharmacies.filter((p) => p.present_in_snapshot);
  shops.forEach((s, i) => { s.bit = i; });

  return {
    meta,
    P,
    D,
    shops,
    absent: meta.pharmacies.filter((p) => !p.present_in_snapshot),
    keyIndex: new Map(raw.key.map((k, i) => [k, i])),
    listings: null,
    // Products grouped by active ingredient, built once. This is the
    // substitution graph James asked for: when a product is out of stock, the
    // clinically meaningful question is what else on the panel carries the
    // same molecule and is in stock somewhere.
    byIngredient: (() => {
      const m = new Map();
      for (let i = 0; i < n; i++) {
        const a = P.ingredient[i];
        if (a < 0) continue;
        if (!m.has(a)) m.set(a, []);
        m.get(a).push(i);
      }
      return m;
    })(),
  };
}

/** Per-listing detail, loaded on demand for the drawer and the source screens. */
export async function loadListings(store, onProgress) {
  if (store.listings) return store.listings;
  const raw = await getJson('listings', onProgress);
  const L = {
    count: raw.count,
    product: i32(raw.product),
    shop: u8(raw.shop),
    state: u8(raw.state),
    price: f64(raw.price),
    urlOrigin: i32(raw.urlOrigin),
    urlPath: raw.urlPath,
    rawName: i32(raw.rawName),
    sku: raw.sku,
    dict: raw.dictionaries,
    byProduct: null,
  };

  // One bucketed index so a product's listings are an O(1) slice instead of a
  // 51,350-row scan every time the drawer opens.
  const counts = new Int32Array(store.P.n + 1);
  for (let i = 0; i < L.count; i++) counts[L.product[i]]++;
  const starts = new Int32Array(store.P.n + 1);
  let acc = 0;
  for (let i = 0; i <= store.P.n; i++) { starts[i] = acc; acc += counts[i] || 0; }
  const cursor = starts.slice();
  const order = new Int32Array(L.count);
  for (let i = 0; i < L.count; i++) order[cursor[L.product[i]]++] = i;
  L.byProduct = { starts, order };

  store.listings = L;
  return L;
}

/** Every listing row for one product, resolved to display values. */
export function listingsFor(store, productIdx) {
  const L = store.listings;
  if (!L) return [];
  const { starts, order } = L.byProduct;
  const out = [];
  for (let i = starts[productIdx]; i < starts[productIdx + 1]; i++) {
    const r = order[i];
    const origin = L.urlOrigin[r] >= 0 ? L.dict.urlOrigin[L.urlOrigin[r]] : '';
    out.push({
      shop: store.shops[L.shop[r]],
      state: ['in_stock', 'out_of_stock', 'not_published'][L.state[r]],
      price: Number.isFinite(L.price[r]) && L.price[r] > 0 ? L.price[r] : null,
      url: origin ? origin + L.urlPath[r] : (L.urlPath[r] || null),
      rawName: L.rawName[r] >= 0 ? L.dict.rawName[L.rawName[r]] : '',
      sku: L.sku[r] || null,
    });
  }
  return out.sort((a, b) => {
    const rank = (s) => (s.state === 'out_of_stock' ? 0 : s.state === 'in_stock' ? 1 : 2);
    return rank(a) - rank(b) || a.shop.name.localeCompare(b.shop.name);
  });
}
