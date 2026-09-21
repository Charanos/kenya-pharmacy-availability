/**
 * Re-run classification against a newer DrugIndex, without re-ingesting.
 *
 *   node pipeline/reclassify.js [--source <dir>] [--out <dir>]
 *                               [--snapshot <id>] [--force] [--dry-run]
 *
 * WHY THIS EXISTS: the DrugIndex scrape is unfinished and accretive. Every
 * time it grows, more of the catalogue becomes classifiable -- with the
 * September reference set, DrugIndex is worth about ten points of medicine
 * classification (15.4% of products without it, 25.5% with it). Re-running the
 * whole build to pick that up would re-read 51,350 rows, redo the matching and
 * rewrite history for no reason: matching does not depend on DrugIndex at all.
 *
 * So this reclassifies in place. It reads the products and their shop
 * categories back out of the database, re-scores them against the current
 * reference set, reports exactly what moved, and rewrites the product table
 * and the Parquet read models. Typically a couple of seconds.
 *
 * It is a no-op when the DrugIndex fingerprint has not changed, so it is safe
 * to wire into a cron or a post-scrape hook and let it decide for itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

import { classify, CLASSIFIER_VERSION, CLINICAL_TYPES } from './classify.js';
import { loadDrugIndex, summariseCatalogueCoverage, describeDrugIndex } from './drugindex.js';
import { castList, TABLES } from './schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const SOURCE = path.resolve(ROOT, opt('--source', '../04_Working Data'));
const OUT = path.resolve(ROOT, opt('--out', './data'));
const FORCE = flag('--force');
const DRY = flag('--dry-run');

const dbPath = path.join(OUT, 'kpad.duckdb');
if (!fs.existsSync(dbPath)) {
  console.error(`\nno database at ${dbPath} — run \`npm run build\` first\n`);
  process.exit(2);
}

const log = (...a) => console.log(...a);
const posix = (p) => p.replace(/\\/g, '/');
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

const instance = await DuckDBInstance.create(dbPath);
const db = await instance.connect();
const q = (sql) => db.run(sql);
const rows = async (sql) => (await (await db.run(sql)).getRowObjects())
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])));

const SNAPSHOT = opt('--snapshot', (await rows('SELECT snapshot_id FROM latest_snapshot'))[0]?.snapshot_id);
if (!SNAPSHOT) { console.error('\nno snapshot found in database\n'); process.exit(2); }

log(`\nReclassify — snapshot ${SNAPSHOT}`);

/* ------------------------------------------------- is there anything to do */

const di = loadDrugIndex(SOURCE);
log(`  ${describeDrugIndex(di)}`);

const prior = (await rows(
  `SELECT fingerprint, brands_rows, ingredients_rows, products_awaiting_drugindex
   FROM drugindex_snapshot WHERE snapshot_id = '${SNAPSHOT}'`
))[0];

if (prior && prior.fingerprint === di.fingerprint && !FORCE) {
  log(`  reference set unchanged (${di.fingerprint}) — nothing to do. Use --force to reclassify anyway.\n`);
  process.exit(0);
}
if (prior) {
  log(`  reference set changed: ${prior.fingerprint} -> ${di.fingerprint}`);
  log(`    brands      ${prior.brands_rows} -> ${di.stats.brands_rows} (${di.stats.brands_rows - prior.brands_rows >= 0 ? '+' : ''}${di.stats.brands_rows - prior.brands_rows})`);
  log(`    ingredients ${prior.ingredients_rows} -> ${di.stats.ingredients_rows} (${di.stats.ingredients_rows - prior.ingredients_rows >= 0 ? '+' : ''}${di.stats.ingredients_rows - prior.ingredients_rows})`);
}
for (const w of di.warnings) log(`  ! ${w}`);

/* -------------------------------------------------------------- reclassify */

// Shop categories live on the observations, so they are re-aggregated per
// product rather than being duplicated onto the product table.
const current = await rows(`
  SELECT p.product_key, p.canonical_name, p.form, p.product_type AS old_type,
         p.class_gap_reason AS old_gap, p.match_confidence_band, p.pharmacies_listing,
         -- Delimited rather than list(): DuckDB LIST values do not marshal to
         -- a plain JS array through the node API, and a separator that cannot
         -- occur in a category label round-trips without any type handling.
         string_agg(DISTINCT o.category_raw, '') AS categories
  FROM product_snapshot p
  LEFT JOIN observation o
    ON o.snapshot_id = p.snapshot_id AND o.product_key = p.product_key
  WHERE p.snapshot_id = '${SNAPSHOT}'
  GROUP BY ALL
`);

log(`  reclassifying ${current.length.toLocaleString()} products...`);

const updates = [];
const moved = new Map();
let newlyClassified = 0;
let lostClassification = 0;

for (const p of current) {
  const cls = classify({
    name: p.canonical_name,
    categories: p.categories ? String(p.categories).split('').filter(Boolean) : [],
    form: p.form,
    di,
  });

  const lowMatch = p.match_confidence_band === 'low' && p.pharmacies_listing > 1;

  if (cls.product_type !== p.old_type) {
    const k = `${p.old_type} -> ${cls.product_type}`;
    moved.set(k, (moved.get(k) ?? 0) + 1);
    if (p.old_type === 'unclassified') newlyClassified++;
    if (cls.product_type === 'unclassified') lostClassification++;
  }

  updates.push({
    snapshot_id: SNAPSHOT,
    product_key: p.product_key,
    ...cls,
    is_clinical: CLINICAL_TYPES.has(cls.product_type),
    review_state: (lowMatch || cls.class_contested) ? 'needs_review' : 'auto',
    review_reason: lowMatch ? 'low match confidence'
      : cls.class_contested ? 'contested classification' : null,
  });
}

const coverage = summariseCatalogueCoverage(updates.map((u) => ({
  di_brand_key: u.di_brand_key, di_ai_key: u.di_ai_key,
  active_ingredient: u.active_ingredient, indications: u.indications,
  class_gap_reason: u.class_gap_reason, product_type: u.product_type,
})));

log(`\n  changes`);
if (!moved.size) {
  log(`    none — classification is identical`);
} else {
  for (const [k, n] of [...moved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    log(`    ${String(n).padStart(6)}  ${k}`);
  }
  if (moved.size > 12) log(`    ${moved.size - 12} further transition(s)`);
}
log(`\n    newly classified                ${newlyClassified}`);
log(`    fell back to unclassified       ${lostClassification}`);
log(`    still awaiting reference data   ${coverage.products_awaiting_drugindex}`
  + ` (was ${prior?.products_awaiting_drugindex ?? '—'})`);
log(`    drugindex match rate            ${(100 * (coverage.drugindex_match_rate ?? 0)).toFixed(1)}%`);

if (DRY) {
  log(`\n  --dry-run: nothing written\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ write */

const staging = path.join(OUT, '_staging');
fs.mkdirSync(staging, { recursive: true });
const file = posix(path.join(staging, 'reclass.ndjson'));
fs.writeFileSync(file, updates.map((u) => JSON.stringify(u)).join('\n') + '\n');

await q('BEGIN TRANSACTION');
try {
  await q(`CREATE OR REPLACE TEMP TABLE reclass AS
           SELECT * FROM read_json_auto('${file}', format='newline_delimited', sample_size=-1)`);

  await q(`
    UPDATE product_snapshot p SET
      product_type          = r.product_type,
      classifier_version    = r.classifier_version,
      class_confidence      = CAST(r.class_confidence AS DOUBLE),
      class_basis           = r.class_basis,
      class_contested       = CAST(r.class_contested AS BOOLEAN),
      class_gap_reason      = r.class_gap_reason,
      di_brand_key          = r.di_brand_key,
      di_ai_key             = r.di_ai_key,
      active_ingredient     = r.active_ingredient,
      indications           = r.indications,
      therapeutic_category  = r.therapeutic_category,
      drugindex_fingerprint = r.drugindex_fingerprint,
      is_clinical           = CAST(r.is_clinical AS BOOLEAN),
      review_state          = r.review_state,
      review_reason         = r.review_reason
    FROM reclass r
    WHERE p.snapshot_id = r.snapshot_id AND p.product_key = r.product_key
  `);

  // Refresh the coverage row so the dashboard's DrugIndex caveat matches what
  // the products now say.
  const diRow = {
    snapshot_id: SNAPSHOT,
    fingerprint: di.fingerprint,
    loaded_at: di.loaded_at,
    available: di.available,
    missing_files: di.missing.join(',') || null,
    warnings: di.warnings.join(' · ') || null,
    ...di.stats,
    link_brand_to_ingredient: di.linkage.brand_to_ingredient,
    link_brand_to_manufacturer: di.linkage.brand_to_manufacturer,
    link_ingredient_to_indications: di.linkage.ingredient_to_indications,
    link_ingredient_to_dosage: di.linkage.ingredient_to_dosage,
    link_ingredient_to_contraindications: di.linkage.ingredient_to_contraindications,
    link_ingredient_to_category: di.linkage.ingredient_to_category,
    ...coverage,
  };
  const diFile = posix(path.join(staging, 'di.ndjson'));
  fs.writeFileSync(diFile, JSON.stringify(diRow) + '\n');
  await q(`DELETE FROM drugindex_snapshot WHERE snapshot_id = '${SNAPSHOT}'`);
  await q(`INSERT INTO drugindex_snapshot SELECT ${castList(TABLES.drugindex_snapshot)}
           FROM read_json_auto('${diFile}', format='newline_delimited', sample_size=-1)`);

  await q('COMMIT');
} catch (err) {
  await q('ROLLBACK');
  console.error(`\n  reclassify failed, database rolled back: ${err.message}\n`);
  process.exit(1);
}

// Only the latest snapshot is exported, so skip the rewrite when an older one
// was reclassified.
const latest = (await rows('SELECT snapshot_id FROM latest_snapshot'))[0]?.snapshot_id;
if (latest === SNAPSHOT) {
  for (const [name, source] of [['product', 'product'], ['drugindex_coverage', 'drugindex_coverage']]) {
    await q(`COPY (SELECT * FROM ${source}) TO '${posix(path.join(OUT, `${name}.parquet`))}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  }
  log(`\n  rewrote product.parquet and drugindex_coverage.parquet`);
} else {
  log(`\n  ${SNAPSHOT} is not the latest snapshot (${latest}) — Parquet read models left untouched`);
}

fs.rmSync(staging, { recursive: true, force: true });
log(`  done (classifier ${CLASSIFIER_VERSION}, reference ${di.fingerprint})\n`);
