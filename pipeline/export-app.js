/**
 * Browser read model.
 *
 *   node pipeline/export-app.js [--out static/app]
 *
 * WHY NOT DuckDB-WASM: the MVP bundle is a 41 MB WebAssembly download before
 * the first pixel, to query 43,606 rows. Forty-three thousand rows is nothing
 * for JavaScript -- a full predicate sweep over every column is around a
 * millisecond with typed arrays. The engine was buying query expressiveness we
 * can get for free and charging a first paint for it. The DuckDB file stays on
 * the backend, where it is genuinely the right tool.
 *
 * SHAPE: columnar, dictionary-encoded, and split so the heavy part loads
 * second. Column arrays compress far better than an array of objects (the keys
 * are not repeated 43,606 times) and land directly in typed arrays.
 *
 * The trick that carries the whole UI: there are 15 pharmacies, so each
 * product's presence is three uint16 bitmasks -- listed, in stock, out of
 * stock. Every per-source filter, the availability matrix and the coverage
 * charts read those masks. No join, no per-listing scan, no observation
 * payload needed for the main grid.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const DATA = path.resolve(ROOT, opt('--data', './data'));
const OUT = path.resolve(ROOT, opt('--out', './static/app'));
const DB = path.join(DATA, 'kpad.duckdb');

if (!fs.existsSync(DB)) {
  console.error(`\nno database at ${DB} — run \`npm run build\` first\n`);
  process.exit(2);
}

const instance = await DuckDBInstance.create(DB, { access_mode: 'READ_ONLY' });
const db = await instance.connect();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * DuckDB TIMESTAMP comes back through the node API as `{ micros: BigInt }`,
 * not a JS Date, so it serialises to an object and the browser reads it as an
 * invalid date. Normalise every temporal value to an ISO string here.
 */
const cell = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && 'micros' in v) {
    return new Date(Number(v.micros) / 1000).toISOString();
  }
  if (v && typeof v === 'object' && 'days' in v) {
    return new Date(Number(v.days) * 86400000).toISOString();
  }
  return num(v);
};
const Q = async (sql) => (await (await db.run(sql)).getRowObjects())
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));

/** Dictionary encoder: repeated strings become one table plus an index column. */
function dict() {
  const index = new Map();
  const values = [];
  return {
    values,
    put(v) {
      if (v === null || v === undefined || v === '') return -1;
      const s = String(v);
      let i = index.get(s);
      if (i === undefined) { i = values.length; values.push(s); index.set(s, i); }
      return i;
    },
  };
}

const round = (v, dp = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/* ------------------------------------------------------------- pharmacies */

const pharmacies = await Q(`
  SELECT pharmacy_id, name, platform, scrape_method, robots_posture,
         present_in_snapshot, absent_reason, listings, in_stock, out_of_stock,
         unknown_status, distinct_status_values, publishes_oos, quarantined,
         health_score, health_flags, health_detail, listing_key_strategy,
         rows_skipped, duplicate_listing_ids, urls_repaired
  FROM pharmacy
  ORDER BY present_in_snapshot DESC, listings DESC
`);

// Bit position per pharmacy. 15 present shops fit in a uint16 with room spare.
const present = pharmacies.filter((p) => p.present_in_snapshot);
const bitOf = new Map(present.map((p, i) => [p.pharmacy_id, i]));
present.forEach((p, i) => { p.bit = i; });

/* --------------------------------------------------------------- products */

const products = await Q(`
  SELECT p.product_key, p.canonical_name, p.product_type, p.is_clinical, p.form,
         p.pack_sig, p.pack_kind, p.pack_value, p.pack_unit,
         p.strength_sig, p.strength_value,
         p.listings, p.pharmacies_listing, p.pharmacies_eligible,
         p.pharmacies_oos, p.pharmacies_in_stock, p.oos_share_of_eligible,
         p.cluster_band, p.match_confidence, p.match_confidence_band,
         p.match_price_cv, p.match_flags, p.review_state, p.review_reason,
         p.price_min, p.price_median, p.price_max,
         p.class_confidence, p.class_contested, p.class_gap_reason,
         p.active_ingredient, p.indications, p.therapeutic_category,
         p.di_brand_key, p.token_count
  FROM product p
  ORDER BY p.pharmacies_oos DESC, p.pharmacies_listing DESC, p.canonical_name
`);

const keyToIdx = new Map(products.map((p, i) => [p.product_key, i]));

// Masks and per-shop prices, built from the observations in one pass.
const listedMask = new Uint16Array(products.length);
const inMask = new Uint16Array(products.length);
const oosMask = new Uint16Array(products.length);
const categoryBits = products.map(() => new Set());

const obs = await Q(`
  SELECT product_key, pharmacy_id, stock_evidence, price_kes, category_raw, brand_raw,
         raw_name, product_url, sku
  FROM observation_scored
`);

const catDict = dict();
const brandDict = dict();
const urlOriginDict = dict();
const rawNameDict = dict();

const lProduct = new Int32Array(obs.length);
const lShop = new Uint8Array(obs.length);
const lState = new Uint8Array(obs.length);      // 0 in_stock · 1 out_of_stock · 2 not_published
const lPrice = new Float64Array(obs.length);
const lUrlOrigin = new Int32Array(obs.length);
const lUrlPath = new Array(obs.length);
const lRawName = new Int32Array(obs.length);
const lSku = new Array(obs.length);

const STATE_CODE = { in_stock: 0, out_of_stock: 1, not_published: 2 };

let n = 0;
for (const o of obs) {
  const pi = keyToIdx.get(o.product_key);
  const bit = bitOf.get(o.pharmacy_id);
  if (pi === undefined || bit === undefined) continue;

  listedMask[pi] |= (1 << bit);
  if (o.stock_evidence === 'in_stock') inMask[pi] |= (1 << bit);
  else if (o.stock_evidence === 'out_of_stock') oosMask[pi] |= (1 << bit);

  if (o.category_raw) categoryBits[pi].add(catDict.put(o.category_raw));

  lProduct[n] = pi;
  lShop[n] = bit;
  lState[n] = STATE_CODE[o.stock_evidence] ?? 2;
  lPrice[n] = o.price_kes ?? 0;
  lRawName[n] = rawNameDict.put(o.raw_name);
  lSku[n] = o.sku ?? '';

  // Product URLs are per-shop templated, so the origin is one dictionary entry
  // and only the path varies. This is most of the listing payload.
  if (o.product_url) {
    const m = String(o.product_url).match(/^(https?:\/\/[^/]+)(.*)$/);
    lUrlOrigin[n] = m ? urlOriginDict.put(m[1]) : -1;
    lUrlPath[n] = m ? m[2] : String(o.product_url);
  } else {
    lUrlOrigin[n] = -1;
    lUrlPath[n] = '';
  }
  if (o.brand_raw) brandDict.put(o.brand_raw);
  n++;
}

/* ------------------------------------------------------------- encode */

const typeDict = dict();
const formDict = dict();
const bandDict = dict();
const confDict = dict();
const reviewDict = dict();
const gapDict = dict();
const packKindDict = dict();
const ingredientDict = dict();
const indicationDict = dict();
const flagsDict = dict();
const therapeuticDict = dict();

const P = {
  key: products.map((p) => p.product_key),
  name: products.map((p) => p.canonical_name),
  type: products.map((p) => typeDict.put(p.product_type)),
  clinical: products.map((p) => (p.is_clinical ? 1 : 0)),
  form: products.map((p) => formDict.put(p.form)),
  packKind: products.map((p) => packKindDict.put(p.pack_kind)),
  packValue: products.map((p) => round(p.pack_value, 3)),
  packSig: products.map((p) => p.pack_sig ?? ''),
  strengthValue: products.map((p) => round(p.strength_value, 3)),
  listings: products.map((p) => p.listings),
  nListed: products.map((p) => p.pharmacies_listing),
  nEligible: products.map((p) => p.pharmacies_eligible),
  nOos: products.map((p) => p.pharmacies_oos),
  nIn: products.map((p) => p.pharmacies_in_stock),
  oosShare: products.map((p) => round(p.oos_share_of_eligible, 3)),
  band: products.map((p) => bandDict.put(p.cluster_band)),
  matchConf: products.map((p) => round(p.match_confidence, 3)),
  matchBand: products.map((p) => confDict.put(p.match_confidence_band)),
  priceCv: products.map((p) => round(p.match_price_cv, 3)),
  matchFlags: products.map((p) => flagsDict.put(p.match_flags)),
  review: products.map((p) => reviewDict.put(p.review_state)),
  gap: products.map((p) => gapDict.put(p.class_gap_reason)),
  classConf: products.map((p) => round(p.class_confidence, 3)),
  contested: products.map((p) => (p.class_contested ? 1 : 0)),
  priceMin: products.map((p) => round(p.price_min)),
  priceMed: products.map((p) => round(p.price_median)),
  priceMax: products.map((p) => round(p.price_max)),
  ingredient: products.map((p) => ingredientDict.put(p.active_ingredient)),
  indications: products.map((p) => indicationDict.put(p.indications)),
  // Populated upstream now that the register's category links are captured:
  // 9,189 products across 19 classes, 58.5% of clinical ones. Null is a real
  // state here, not an error, so it stays a -1 rather than a bucket.
  therapeutic: products.map((p) => therapeuticDict.put(p.therapeutic_category)),
  hasMonograph: products.map((p) => (p.di_brand_key ? 1 : 0)),
  listedMask: Array.from(listedMask),
  inMask: Array.from(inMask),
  oosMask: Array.from(oosMask),
  categories: categoryBits.map((s) => [...s]),
};

const headline = (await Q('SELECT * FROM kpi_headline'))[0];
const coverage = (await Q('SELECT * FROM drugindex_coverage'))[0];
const run = (await Q('SELECT * FROM current_run'))[0];
const typeMix = await Q('SELECT product_type, count(*) AS products FROM product GROUP BY 1 ORDER BY products DESC');
const bandMix = await Q(`SELECT cluster_band, count(*) AS products FROM product GROUP BY 1`);
const snapshots = await Q('SELECT snapshot_id, count(*) AS listings FROM observation GROUP BY 1 ORDER BY 1');

// Price distribution, computed here so the browser never sorts 43k floats on
// load. Log-spaced buckets: retail pharmacy prices span four orders of
// magnitude and linear buckets would put 90% of the catalogue in bucket one.
const priceHist = await Q(`
  WITH b AS (
    SELECT least(greatest(floor(ln(nullif(price_median, 0)) / ln(10) * 4), -4), 24) AS bucket,
           count(*) AS n, product_type
    FROM product WHERE price_median > 0 GROUP BY 1, 3
  )
  SELECT bucket, product_type, n FROM b ORDER BY bucket
`);

const meta = {
  generated_at: new Date().toISOString(),
  contract_version: run?.contract_version ?? null,
  run: {
    run_id: run?.run_id ?? null,
    snapshot_id: run?.snapshot_id ?? null,
    match_algo_version: run?.match_algo_version ?? null,
    classifier_version: run?.classifier_version ?? null,
    drugindex_fingerprint: run?.drugindex_fingerprint ?? null,
    snapshot_at: headline?.snapshot_at ?? null,
    snapshot_at_inferred: Boolean(run?.snapshot_at_inferred),
    shops_ingested: run?.shops_ingested ?? null,
    shops_failed: run?.shops_failed ?? null,
    warnings: run?.warnings ?? null,
  },
  headline,
  coverage,
  pharmacies,
  typeMix,
  bandMix,
  snapshots,
  priceHist,
  dictionaries: {
    type: typeDict.values,
    form: formDict.values,
    band: bandDict.values,
    matchBand: confDict.values,
    review: reviewDict.values,
    gap: gapDict.values,
    packKind: packKindDict.values,
    ingredient: ingredientDict.values,
    indications: indicationDict.values,
    matchFlags: flagsDict.values,
    therapeutic: therapeuticDict.values,
    category: catDict.values,
  },
};

const listings = {
  count: n,
  product: Array.from(lProduct.slice(0, n)),
  shop: Array.from(lShop.slice(0, n)),
  state: Array.from(lState.slice(0, n)),
  price: Array.from(lPrice.slice(0, n)).map((v) => round(v)),
  urlOrigin: Array.from(lUrlOrigin.slice(0, n)),
  urlPath: lUrlPath.slice(0, n),
  rawName: Array.from(lRawName.slice(0, n)),
  sku: lSku.slice(0, n),
  dictionaries: {
    urlOrigin: urlOriginDict.values,
    rawName: rawNameDict.values,
  },
};

/* --------------------------------------------------------------- write */

fs.mkdirSync(OUT, { recursive: true });
const written = [];
for (const [name, payload] of [['meta', meta], ['products', P], ['listings', listings]]) {
  // DuckDB hands back BigInt for several aggregate types; the row mapper
  // catches top-level columns but not values nested inside struct results.
  const json = JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? Number(v) : v));
  const file = path.join(OUT, `${name}.json`);
  fs.writeFileSync(file, json);
  written.push([name, json.length, zlib.gzipSync(json, { level: 9 }).length]);
}

const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
console.log(`\nBrowser read model -> ${path.relative(ROOT, OUT)}`);
for (const [name, raw, gz] of written) {
  console.log(`  ${`${name}.json`.padEnd(16)} ${mb(raw).padStart(9)} raw  ${mb(gz).padStart(9)} gzipped`);
}
console.log(`  ${'TOTAL'.padEnd(16)} ${mb(written.reduce((a, w) => a + w[1], 0)).padStart(9)} raw  `
  + `${mb(written.reduce((a, w) => a + w[2], 0)).padStart(9)} gzipped`);
console.log(`\n  ${products.length.toLocaleString()} products · ${n.toLocaleString()} listings · `
  + `${present.length} pharmacies as bitmask positions\n`);
