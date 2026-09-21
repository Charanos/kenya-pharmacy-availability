/**
 * Pipeline build: raw scrape JSON -> fact table -> matching -> classification
 *                                 -> DuckDB + Parquet read models.
 *
 *   node pipeline/build.js [options]
 *     --source <dir>     raw scrape JSON            (default ../04_Working Data)
 *     --out <dir>        output directory           (default ./data)
 *     --snapshot <id>    snapshot label             (default S<YYYY-MM> of newest source file)
 *     --rebuild          discard history and start the database fresh
 *     --strict           fail the run if any shop fails to ingest
 *
 * SNAPSHOTS ACCUMULATE. Re-running the same snapshot id replaces just that
 * snapshot's rows, so the command is idempotent; running a new one appends.
 * That is the change that turns this from a spreadsheet into a time series,
 * and every metric worth having -- new stockouts, days out of stock, recovery
 * time, price movement, feed volatility -- depends on it existing from run #1.
 *
 * The physical tables hold every snapshot. The views named `product`,
 * `pharmacy`, `observation_scored`, `kpi_headline` and `shortage_signal`
 * always resolve to the LATEST snapshot, so a consumer that does not care
 * about history reads them exactly as before and stays correct once a second
 * snapshot lands. `*_history` views expose the full series.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

import { CONTRACT_VERSION, MATCH } from './config.js';
import { MATCH_ALGO_VERSION, scoreGroup } from './normalize.js';
import { SHOPS, ABSENT, assessFeed } from './shops.js';
import { classify, CLASSIFIER_VERSION, CLINICAL_TYPES } from './classify.js';
import { loadDrugIndex, summariseCatalogueCoverage, describeDrugIndex } from './drugindex.js';
import { ingestShop, IngestError, readScrapeMeta } from './ingest.js';
import { TABLES, castList, columnList } from './schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SOURCE = path.resolve(ROOT, opt('--source', '../04_Working Data'));
const OUT = path.resolve(ROOT, opt('--out', './data'));
const REBUILD = flag('--rebuild');
const STRICT = flag('--strict');

const startedAt = new Date();
const runId = crypto.randomUUID();
const warnings = [];
const log = (...a) => console.log(...a);
const warn = (msg) => { warnings.push(msg); log(`  ! ${msg}`); };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

if (!fs.existsSync(SOURCE)) {
  console.error(`\nsource directory not found: ${SOURCE}\n`);
  process.exit(2);
}

/**
 * Default the snapshot label to the calendar month the newest shop was scraped.
 *
 * The scrapers stamp each run in a <shop>.meta.json sidecar, so that is the
 * authority. Only a shop with no sidecar falls back to its file's mtime, which
 * is a guess -- any copy or sync resets it -- and the fallback is reported.
 */
function defaultSnapshotId() {
  const times = [];
  let inferred = 0;
  for (const shopId of Object.keys(SHOPS)) {
    const file = path.join(SOURCE, `${shopId}.json`);
    if (!fs.existsSync(file)) continue;
    const { at } = readScrapeMeta(shopId, SOURCE);
    if (at) times.push(at);
    else { times.push(fs.statSync(file).mtime); inferred++; }
  }
  if (!times.length) return { id: `S${startedAt.toISOString().slice(0, 7)}`, inferred: 0, shops: 0 };
  const newest = new Date(Math.max(...times.map((d) => d.getTime())));
  return { id: `S${newest.toISOString().slice(0, 7)}`, inferred, shops: times.length };
}
const snapshotDefault = defaultSnapshotId();
const SNAPSHOT_ID = opt('--snapshot', snapshotDefault.id);

log(`\nKenya Pharmacy Availability — pipeline build`);
log(`  contract ${CONTRACT_VERSION} · match ${MATCH_ALGO_VERSION} · classifier ${CLASSIFIER_VERSION}`);
log(`  snapshot ${SNAPSHOT_ID}${opt('--snapshot', null) ? ' (given)'
  : !snapshotDefault.inferred
    ? ' (from the scrapers’ own timestamps)'
    : snapshotDefault.inferred === snapshotDefault.shops
      ? ' (inferred from file mtime — no shop has a .meta.json sidecar yet)'
      : ` (from scrape timestamps; ${snapshotDefault.inferred} of ${snapshotDefault.shops} shops fell back to file mtime)`}`);
log(`  source   ${SOURCE}\n`);

/* ====================================================== 1. reference data */

const drugIndex = loadDrugIndex(SOURCE);
log(`  ${describeDrugIndex(drugIndex)}`);
for (const w of drugIndex.warnings) warn(`drugindex: ${w}`);

/* ============================================================= 2. ingest */

const observations = [];
const pharmacies = [];
const scrapeTimes = [];
let shopsIngested = 0;
let shopsFailed = 0;
let shopsTimestamped = 0;
let shopsTimeInferred = 0;

for (const [shopId, meta] of Object.entries(SHOPS)) {
  let result;
  try {
    result = ingestShop({ shopId, sourceDir: SOURCE, snapshotId: SNAPSHOT_ID });
  } catch (err) {
    // One bad shop degrades the run, it does not end it -- mirroring how
    // run_all.py isolates each scraper. A 14-shop dashboard that says so is
    // more useful than no dashboard.
    shopsFailed++;
    const detail = err instanceof IngestError ? err.message : `${err.name}: ${err.message}`;
    warn(`${meta.name}: ${detail}`);
    pharmacies.push({
      snapshot_id: SNAPSHOT_ID, pharmacy_id: shopId, name: meta.name,
      platform: meta.platform, scrape_method: meta.method, robots_posture: meta.robots,
      present_in_snapshot: false, absent_reason: 'ingest failed',
      listings: 0, rows_in_file: 0, rows_skipped: 0,
      listing_key_strategy: null, listing_key_cardinality: 0,
      duplicate_listing_ids: 0, urls_repaired: 0,
      in_stock: 0, out_of_stock: 0, unknown_status: 0, distinct_status_values: 0,
      publishes_oos: false, quarantined: true, health_score: 0,
      health_flags: 'ingest_error', health_detail: detail,
      ingest_error: detail, last_success_at: null,
    });
    continue;
  }

  const { observations: rows, stats } = result;
  observations.push(...rows);
  shopsIngested++;

  if (stats.snapshot_at_inferred) shopsTimeInferred++; else shopsTimestamped++;
  scrapeTimes.push({ name: meta.name, at: stats.snapshot_at, source: stats.snapshot_at_source });
  // A sidecar that exists but cannot be read is worse than one that is absent:
  // it means the scrapers think they are stamping runs and they are not.
  if (stats.scrape_meta_problem) warn(`${meta.name}: ${stats.scrape_meta_problem} - falling back to file mtime`);

  const health = assessFeed({
    rows: stats.rows_ingested,
    distinctStatuses: stats.distinct_statuses,
    inStock: stats.in_stock,
    outOfStock: stats.out_of_stock,
    unknown: stats.unknown_status,
  });

  pharmacies.push({
    snapshot_id: SNAPSHOT_ID,
    pharmacy_id: shopId,
    name: meta.name,
    platform: meta.platform,
    scrape_method: meta.method,
    robots_posture: meta.robots,
    present_in_snapshot: true,
    absent_reason: null,
    listings: stats.rows_ingested,
    rows_in_file: stats.rows_in_file,
    rows_skipped: stats.rows_skipped,
    listing_key_strategy: stats.listing_key_strategy,
    listing_key_cardinality: stats.listing_key_cardinality,
    duplicate_listing_ids: stats.duplicate_listing_ids,
    urls_repaired: stats.urls_repaired,
    in_stock: stats.in_stock,
    out_of_stock: stats.out_of_stock,
    unknown_status: stats.unknown_status,
    distinct_status_values: stats.distinct_statuses.length,
    publishes_oos: health.publishes_oos,
    quarantined: health.quarantined,
    health_score: health.health_score,
    health_flags: health.flags.map((f) => f.rule).join(',') || null,
    health_detail: health.flags.map((f) => `${f.rule}: ${f.detail}`).join(' · ') || null,
    ingest_error: null,
    last_success_at: stats.source_mtime,
  });

  if (stats.rows_skipped) warn(`${meta.name}: skipped ${stats.rows_skipped} malformed rows`);

  log(
    `  ${meta.name.padEnd(20)} ${String(stats.rows_ingested).padStart(6)} rows  `
    + `${pct(stats.in_stock, stats.rows_ingested).padStart(6)} in stock  key=${stats.listing_key_strategy}`
    + `  ${stats.snapshot_at.slice(0, 16).replace('T', ' ')}Z`
    + (stats.snapshot_at_inferred ? '~' : ' ')
    + (health.quarantined ? ` ! ${health.flags.map((f) => f.rule).join(',')}` : '')
  );
}

for (const [id, a] of Object.entries(ABSENT)) {
  pharmacies.push({
    snapshot_id: SNAPSHOT_ID, pharmacy_id: id, name: a.name,
    platform: null, scrape_method: null, robots_posture: null,
    present_in_snapshot: false, absent_reason: a.reason,
    listings: 0, rows_in_file: 0, rows_skipped: 0,
    listing_key_strategy: null, listing_key_cardinality: 0,
    duplicate_listing_ids: 0, urls_repaired: 0,
    in_stock: 0, out_of_stock: 0, unknown_status: 0, distinct_status_values: 0,
    publishes_oos: false, quarantined: true, health_score: 0,
    health_flags: 'absent', health_detail: a.reason,
    ingest_error: null, last_success_at: null,
  });
}

if (!observations.length) {
  console.error('\nno observations ingested — refusing to write an empty snapshot\n');
  process.exit(2);
}
if (STRICT && shopsFailed) {
  console.error(`\n--strict: ${shopsFailed} shop(s) failed to ingest\n`);
  process.exit(1);
}

const urlsRepaired = pharmacies.reduce((a, p) => a + (p.urls_repaired ?? 0), 0);
log(`\n  ${observations.length} observations from ${shopsIngested} shops`
  + (shopsFailed ? `, ${shopsFailed} failed` : '')
  + ` · ${urlsRepaired} product URLs repaired`);

// Whether this snapshot's clock can be trusted, stated plainly. A `~` in the
// per-shop lines above marks the shops that could not be stamped.
const SNAPSHOT_AT_INFERRED = shopsTimeInferred > 0;
const scrapeWindow = scrapeTimes.map((t) => t.at).sort();
if (scrapeWindow.length) {
  const span = scrapeWindow[0] === scrapeWindow[scrapeWindow.length - 1]
    ? scrapeWindow[0].slice(0, 16).replace('T', ' ')
    : `${scrapeWindow[0].slice(0, 16).replace('T', ' ')} .. ${scrapeWindow[scrapeWindow.length - 1].slice(0, 16).replace('T', ' ')}`;
  log(`  scrape window  ${span} UTC`);
}
if (!shopsTimeInferred) {
  log(`  scrape time stamped by the scrapers for all ${shopsTimestamped} shops`);
} else {
  log(`  scrape time: ${shopsTimestamped} from sidecars, ${shopsTimeInferred} inferred from file mtime (~)`);
  warn(`${shopsTimeInferred} shop(s) could not be stamped from a <shop>.meta.json sidecar; their scrape`
    + ' time is inferred from file mtime, which any copy resets. Re-run those scrapers from 03_Scrapers.');
}

/* =================================================== 3. matching engine */

// Group by match_key, then split any group whose members disagree on dose-form
// class: a key built from name tokens will happily merge a tablet with a syrup
// of the same brand and strength. Listings with no form at all inside a
// conflicted group go to their own bucket rather than being guessed onto a side.
const groups = new Map();
for (const o of observations) {
  if (!o.match_key) continue;
  if (!groups.has(o.match_key)) groups.set(o.match_key, []);
  groups.get(o.match_key).push(o);
}

let splitGroups = 0;
for (const [key, members] of groups) {
  const classes = new Set(members.map((m) => m.form_class).filter(Boolean));
  if (classes.size > 1) {
    splitGroups++;
    for (const m of members) m.product_key = `${key}@${m.form_class ?? '?'}`;
  } else {
    for (const m of members) m.product_key = key;
  }
}

// Names whose tokens were all stopwords or numbers stay isolated rather than
// collapsing into one giant bucket.
let unkeyable = 0;
for (const o of observations) {
  o.match_algo_version = MATCH_ALGO_VERSION;
  if (!o.product_key) {
    o.product_key = `~unkeyed:${o.pharmacy_id}:${o.listing_id}`;
    unkeyable++;
  }
}

const products = new Map();
for (const o of observations) {
  if (!products.has(o.product_key)) {
    products.set(o.product_key, {
      product_key: o.product_key, canonical_name: o.canonical_name,
      token_count: o.token_count,
      pack_sig: o.pack_sig, pack_kind: o.pack_kind,
      pack_value: o.pack_value, pack_unit: o.pack_unit,
      strength_sig: o.strength_sig, strength_value: o.strength_value,
      form: o.form, form_class: o.form_class,
      members: [],
    });
  }
  const p = products.get(o.product_key);
  p.members.push(o);
  // Prefer the longest raw name for display: it kept the most detail
  // (strength, pack, flavour) rather than being the most truncated.
  if (o.canonical_name.length > p.canonical_name.length) p.canonical_name = o.canonical_name;
}

// A shop that never publishes an out-of-stock bit can never vote for a
// shortage, so counting it in the denominator understates every cluster.
const PUBLISHES_OOS = new Set(pharmacies.filter((p) => p.publishes_oos).map((p) => p.pharmacy_id));

const productRows = [];
for (const p of products.values()) {
  const shops = new Set(p.members.map((m) => m.pharmacy_id));
  const oosShops = new Set(p.members.filter((m) => m.stock_state === 'out_of_stock').map((m) => m.pharmacy_id));
  const inShops = new Set(p.members.filter((m) => m.stock_state === 'in_stock').map((m) => m.pharmacy_id));
  const eligible = new Set([...shops].filter((s) => PUBLISHES_OOS.has(s)));

  const conf = scoreGroup({
    tokenCount: p.token_count,
    keyLength: p.product_key.length,
    hasPack: Boolean(p.pack_sig),
    hasStrength: Boolean(p.strength_sig),
    prices: p.members.map((m) => m.price_kes),
    pharmacyCount: shops.size,
  });

  for (const m of p.members) {
    m.match_confidence = conf.score;
    m.match_confidence_band = conf.band;
  }

  const cls = classify({
    name: p.canonical_name,
    categories: [...new Set(p.members.map((m) => m.category_raw).filter(Boolean))],
    form: p.form,
    di: drugIndex,
  });

  const prices = p.members.map((m) => m.price_kes).filter(Boolean).sort((a, b) => a - b);
  const lowMatch = conf.band === 'low' && shops.size > 1;

  productRows.push({
    snapshot_id: SNAPSHOT_ID,
    product_key: p.product_key,
    canonical_name: p.canonical_name,
    match_algo_version: MATCH_ALGO_VERSION,
    token_count: p.token_count,
    pack_sig: p.pack_sig, pack_kind: p.pack_kind,
    pack_value: p.pack_value, pack_unit: p.pack_unit,
    strength_sig: p.strength_sig, strength_value: p.strength_value,
    form: p.form, form_class: p.form_class,
    listings: p.members.length,
    pharmacies_listing: shops.size,
    // The honest denominator for "3 out of how many".
    pharmacies_eligible: eligible.size,
    pharmacies_oos: oosShops.size,
    pharmacies_in_stock: inShops.size,
    oos_share_of_eligible: eligible.size ? Math.round((1000 * oosShops.size) / eligible.size) / 1000 : null,
    // All six bands are coded now. September's ceiling is 3 of 15; the bands
    // are what stop a 3/3 being reported in the same voice as a 12/15.
    cluster_band:
      oosShops.size >= 15 ? 'total'
        : oosShops.size >= 10 ? 'national'
          : oosShops.size >= 5 ? 'systemic'
            : oosShops.size >= 3 ? 'cluster'
              : oosShops.size === 2 ? 'local'
                : oosShops.size === 1 ? 'isolated' : 'none',
    match_confidence: conf.score,
    match_confidence_band: conf.band,
    match_price_cv: conf.price_cv,
    match_flags: conf.reasons.join(' · ') || null,
    review_state: (lowMatch || cls.class_contested) ? 'needs_review' : 'auto',
    review_reason: lowMatch ? 'low match confidence' : cls.class_contested ? 'contested classification' : null,
    price_min: prices[0] ?? null,
    price_median: prices.length ? prices[Math.floor(prices.length / 2)] : null,
    price_max: prices[prices.length - 1] ?? null,
    ...cls,
    is_clinical: CLINICAL_TYPES.has(cls.product_type),
  });
}

const multi = productRows.filter((p) => p.pharmacies_listing > 1);
log(`  ${products.size} products · ${splitGroups} groups split on dose-form conflict · ${unkeyable} unkeyable names`);
log(`  ${multi.length} products in 2+ pharmacies (${pct(multi.length, products.size)})`);

const byType = {};
for (const p of productRows) byType[p.product_type] = (byType[p.product_type] ?? 0) + 1;
log(`\n  classification (${CLASSIFIER_VERSION})`);
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  log(`    ${t.padEnd(16)} ${String(n).padStart(6)}  ${pct(n, productRows.length).padStart(6)}`);
}

const coverage = summariseCatalogueCoverage(productRows);
log(`\n  drugindex coverage (reference scrape is INCOMPLETE)`);
log(`    catalogue matched to a brand or ingredient   ${coverage.products_with_drugindex_match} (${pct(coverage.products_with_drugindex_match, coverage.products_total)})`);
log(`    products carrying an active ingredient       ${coverage.products_with_active_ingredient}`);
log(`    unclassified, awaiting reference data        ${coverage.products_awaiting_drugindex} (${pct(coverage.products_awaiting_drugindex, coverage.products_total)})`);
log(`    unclassified, genuinely ambiguous            ${productRows.filter((p) => p.class_gap_reason === 'ambiguous').length}`);

/* =========================================================== 4. persist */

fs.mkdirSync(OUT, { recursive: true });
const staging = path.join(OUT, '_staging');
fs.mkdirSync(staging, { recursive: true });

function writeNdjson(name, rows) {
  const file = path.join(staging, `${name}.ndjson`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file.replace(/\\/g, '/');
}

const diRow = {
  snapshot_id: SNAPSHOT_ID,
  fingerprint: drugIndex.fingerprint,
  loaded_at: drugIndex.loaded_at,
  available: drugIndex.available,
  missing_files: drugIndex.missing.join(',') || null,
  warnings: drugIndex.warnings.join(' · ') || null,
  ...drugIndex.stats,
  link_brand_to_ingredient: drugIndex.linkage.brand_to_ingredient,
  link_brand_to_manufacturer: drugIndex.linkage.brand_to_manufacturer,
  link_ingredient_to_indications: drugIndex.linkage.ingredient_to_indications,
  link_ingredient_to_dosage: drugIndex.linkage.ingredient_to_dosage,
  link_ingredient_to_contraindications: drugIndex.linkage.ingredient_to_contraindications,
  link_ingredient_to_category: drugIndex.linkage.ingredient_to_category,
  ...coverage,
};

const dbPath = path.join(OUT, 'kpad.duckdb');
const metaPath = path.join(OUT, '.contract');

// A contract change means the accumulated tables no longer have the shape the
// code expects, so the safe move is a clean rebuild rather than a failed append.
const storedContract = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8').trim() : null;
const mustRebuild = REBUILD || (storedContract && storedContract !== CONTRACT_VERSION);
if (mustRebuild && fs.existsSync(dbPath)) {
  if (storedContract && storedContract !== CONTRACT_VERSION) {
    warn(`contract changed ${storedContract} -> ${CONTRACT_VERSION}; rebuilding database from scratch (history for prior snapshots is lost)`);
  }
  fs.rmSync(dbPath);
}

const instance = await DuckDBInstance.create(dbPath);
const db = await instance.connect();
const q = (sql) => db.run(sql);
const rows = async (sql) => (await (await db.run(sql)).getRowObjects())
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));

for (const [table, schema] of Object.entries(TABLES)) {
  await q(`CREATE TABLE IF NOT EXISTS ${table} (${columnList(schema)})`);
}

const payloads = {
  observation: observations,
  product_snapshot: productRows,
  pharmacy_snapshot: pharmacies,
  drugindex_snapshot: [diRow],
  run_manifest: [],
};

// Idempotent: re-running a snapshot replaces exactly that snapshot's rows.
for (const [table, schema] of Object.entries(TABLES)) {
  if (table === 'run_manifest') continue;
  await q(`DELETE FROM ${table} WHERE snapshot_id = '${SNAPSHOT_ID}'`);
  const data = payloads[table];
  if (!data?.length) continue;
  const file = writeNdjson(table, data);
  await q(`INSERT INTO ${table} SELECT ${castList(schema)}
           FROM read_json_auto('${file}', format='newline_delimited', sample_size=-1)`);
}

const snapshots = await rows('SELECT DISTINCT snapshot_id FROM observation ORDER BY 1');
log(`\n  database holds ${snapshots.length} snapshot(s): ${snapshots.map((s) => s.snapshot_id).join(', ')}`);

/* ------------------------------------------------------------- views */

// Resolved by observation time first, so re-running an older snapshot never
// hijacks the current view. snapshot_id breaks ties: source mtimes can be
// identical across runs (a rebuild from the same files), and without the
// tiebreak the "latest" snapshot is whichever row the planner happened to
// emit first, which is not a property to leave to chance.
await q(`CREATE OR REPLACE VIEW latest_snapshot AS
         SELECT snapshot_id FROM observation
         GROUP BY 1 ORDER BY max(snapshot_at) DESC, snapshot_id DESC LIMIT 1`);

await q(`CREATE OR REPLACE VIEW observation_history AS
         SELECT o.*, p.publishes_oos, p.quarantined AS pharmacy_quarantined,
                CASE WHEN NOT p.publishes_oos THEN 'not_published' ELSE o.stock_state END AS stock_evidence
         FROM observation o
         JOIN pharmacy_snapshot p USING (snapshot_id, pharmacy_id)`);

// Per-shop scrape time, derived from the fact table rather than stored on
// pharmacy_snapshot, so it needs no schema change and no rebuild. A shop whose
// rows disagree on scrape time would show a window rather than an instant.
await q(`CREATE OR REPLACE VIEW pharmacy_scrape_time AS
         SELECT snapshot_id, pharmacy_id,
                min(snapshot_at)          AS scraped_at,
                max(snapshot_at)          AS scraped_at_latest,
                bool_or(snapshot_at_inferred) AS scraped_at_inferred
         FROM observation GROUP BY 1, 2`);

await q(`CREATE OR REPLACE VIEW product_history AS SELECT * FROM product_snapshot`);
await q(`CREATE OR REPLACE VIEW pharmacy_history AS SELECT * FROM pharmacy_snapshot`);

// Latest-snapshot views. These carry the names the dashboard already reads, so
// a consumer that ignores history keeps working and stays correct.
await q(`CREATE OR REPLACE VIEW observation_scored AS
         SELECT * FROM observation_history WHERE snapshot_id = (SELECT snapshot_id FROM latest_snapshot)`);
await q(`CREATE OR REPLACE VIEW product AS
         SELECT * FROM product_snapshot WHERE snapshot_id = (SELECT snapshot_id FROM latest_snapshot)`);
await q(`CREATE OR REPLACE VIEW pharmacy AS
         SELECT * FROM pharmacy_snapshot WHERE snapshot_id = (SELECT snapshot_id FROM latest_snapshot)`);
await q(`CREATE OR REPLACE VIEW drugindex_coverage AS
         SELECT * FROM drugindex_snapshot WHERE snapshot_id = (SELECT snapshot_id FROM latest_snapshot)`);

await q(`
  CREATE OR REPLACE VIEW kpi_headline AS
  SELECT
    (SELECT snapshot_id FROM latest_snapshot)                                      AS snapshot_id,
    max(snapshot_at)                                                               AS snapshot_at,
    -- bool_or, not bool_and: one shop without a real scrape timestamp is
    -- enough to make the snapshot's headline time partly a guess.
    bool_or(snapshot_at_inferred)                                                  AS snapshot_at_inferred,
    count(*)                                                                       AS listings,
    count(DISTINCT product_key)                                                    AS products,
    count(DISTINCT pharmacy_id)                                                    AS pharmacies,
    count(DISTINCT pharmacy_id) FILTER (WHERE publishes_oos)                       AS pharmacies_publishing_oos,
    count(*) FILTER (WHERE stock_evidence = 'in_stock')                            AS in_stock,
    count(*) FILTER (WHERE stock_evidence = 'out_of_stock')                        AS out_of_stock,
    count(*) FILTER (WHERE stock_evidence = 'not_published')                       AS not_published,
    round(100.0 * count(*) FILTER (WHERE stock_evidence = 'in_stock')
          / nullif(count(*) FILTER (WHERE stock_evidence IN ('in_stock','out_of_stock')), 0), 1)
                                                                                   AS in_stock_rate_gated,
    round(100.0 * count(*) FILTER (WHERE stock_state = 'in_stock') / count(*), 1)  AS in_stock_rate_raw,
    median(price_kes) FILTER (WHERE price_kes IS NOT NULL)                         AS median_price_kes
  FROM observation_scored
`);

// The table the dashboard leads with: clinical products only, counted against
// the shops that can actually report a stockout, matched confidently enough to
// be worth naming in public.
await q(`
  CREATE OR REPLACE VIEW shortage_signal AS
  SELECT product_key, canonical_name, product_type, form, pack_sig, strength_sig,
         active_ingredient, indications, therapeutic_category,
         pharmacies_oos, pharmacies_eligible, pharmacies_listing, pharmacies_in_stock,
         oos_share_of_eligible, cluster_band,
         match_confidence, match_confidence_band, class_confidence,
         price_min, price_median, price_max
  FROM product
  WHERE is_clinical
    AND pharmacies_oos >= 2
    AND match_confidence_band <> 'low'
    AND review_state = 'auto'
  ORDER BY pharmacies_oos DESC, oos_share_of_eligible DESC
`);

// Everything a human needs to adjudicate, in one place: doubtful matches and
// contested classifications, worst first.
await q(`
  CREATE OR REPLACE VIEW review_queue AS
  SELECT product_key, canonical_name, product_type, review_reason,
         class_gap_reason, class_basis, match_flags, match_confidence,
         match_price_cv, pharmacies_listing, price_min, price_max
  FROM product
  WHERE review_state = 'needs_review'
  ORDER BY pharmacies_listing DESC, match_confidence ASC
`);

// Products whose classification is blocked on reference data rather than on
// ambiguity. This is the expected yield from finishing the DrugIndex scrape,
// and it should fall as that scrape progresses.
await q(`
  CREATE OR REPLACE VIEW drugindex_backlog AS
  SELECT product_key, canonical_name, form, pack_sig, listings, pharmacies_listing,
         price_median, class_basis
  FROM product
  WHERE class_gap_reason = 'di_miss'
  ORDER BY pharmacies_listing DESC, listings DESC
`);

// History views degrade to an empty result with a single snapshot rather than
// erroring, so the dashboard can bind to them before snapshot #2 exists.
await q(`
  CREATE OR REPLACE VIEW pharmacy_trend AS
  SELECT p.pharmacy_id, p.name, p.snapshot_id, o.snapshot_at, p.listings,
         p.in_stock, p.out_of_stock, p.publishes_oos, p.quarantined, p.health_score,
         p.listings - lag(p.listings) OVER w                       AS listings_delta,
         round(100.0 * p.in_stock / nullif(p.listings, 0), 1)
           - lag(round(100.0 * p.in_stock / nullif(p.listings, 0), 1)) OVER w
                                                                   AS in_stock_rate_delta
  FROM pharmacy_snapshot p
  JOIN (SELECT snapshot_id, max(snapshot_at) AS snapshot_at FROM observation GROUP BY 1) o
    USING (snapshot_id)
  WINDOW w AS (PARTITION BY p.pharmacy_id ORDER BY o.snapshot_at)
`);

await q(`
  CREATE OR REPLACE VIEW product_trend AS
  SELECT product_key, canonical_name, snapshot_id,
         pharmacies_oos, pharmacies_eligible, cluster_band,
         pharmacies_oos - lag(pharmacies_oos) OVER w  AS oos_delta,
         price_median - lag(price_median) OVER w      AS price_median_delta
  FROM product_snapshot
  WINDOW w AS (PARTITION BY product_key ORDER BY snapshot_id)
`);

/* ---------------------------------------------------------- manifest */

const finishedAt = new Date();
const manifest = {
  run_id: runId,
  snapshot_id: SNAPSHOT_ID,
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  duration_ms: finishedAt - startedAt,
  contract_version: CONTRACT_VERSION,
  match_algo_version: MATCH_ALGO_VERSION,
  classifier_version: CLASSIFIER_VERSION,
  drugindex_fingerprint: drugIndex.fingerprint,
  source_dir: SOURCE,
  shops_expected: Object.keys(SHOPS).length,
  shops_ingested: shopsIngested,
  shops_failed: shopsFailed,
  shops_absent: Object.keys(ABSENT).length,
  observations: observations.length,
  products: productRows.length,
  warnings: warnings.join(' · ') || null,
  // True when ANY shop in the snapshot fell back to mtime. Conservative on
  // purpose: a snapshot whose clock is part guess is not a snapshot with a
  // trustworthy clock, and the dashboard badges it accordingly.
  snapshot_at_inferred: SNAPSHOT_AT_INFERRED,
};
const manifestFile = writeNdjson('run_manifest', [manifest]);
await q(`INSERT INTO run_manifest SELECT ${castList(TABLES.run_manifest)}
         FROM read_json_auto('${manifestFile}', format='newline_delimited', sample_size=-1)`);

// Single row the dashboard can read instead of hardcoding versions in its own
// payload builder.
await q(`CREATE OR REPLACE VIEW current_run AS
         SELECT * FROM run_manifest ORDER BY finished_at DESC LIMIT 1`);

/* ----------------------------------------------------------- export */

// Parquet read models are the LATEST snapshot only: that is what the browser
// needs, and shipping accumulated history to every page load is not free.
// History stays in the DuckDB file.
const posix = (p) => p.replace(/\\/g, '/');
for (const [name, source] of [
  ['observation', 'observation_scored'],
  ['product', 'product'],
  ['pharmacy', 'pharmacy'],
  ['drugindex_coverage', 'drugindex_coverage'],
]) {
  await q(`COPY (SELECT * FROM ${source}) TO '${posix(path.join(OUT, `${name}.parquet`))}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
}

fs.writeFileSync(metaPath, `${CONTRACT_VERSION}\n`);
fs.rmSync(staging, { recursive: true, force: true });

log(`\n  wrote ${OUT}`);
for (const f of ['observation.parquet', 'product.parquet', 'pharmacy.parquet', 'drugindex_coverage.parquet']) {
  log(`    ${f.padEnd(26)} ${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(2).padStart(7)} MB`);
}
log(`    kpad.duckdb                ${(fs.statSync(dbPath).size / 1048576).toFixed(2).padStart(7)} MB`);

const kpi = (await rows('SELECT * FROM kpi_headline'))[0];
log(`\n  headline  ${kpi.in_stock_rate_gated}% in stock (gated) · ${kpi.in_stock_rate_raw}% raw · `
  + `${kpi.listings.toLocaleString()} listings · ${kpi.pharmacies_publishing_oos}/${kpi.pharmacies} feeds publish OOS`);
log(`  run ${runId} in ${manifest.duration_ms} ms${warnings.length ? ` · ${warnings.length} warning(s)` : ''}\n`);
