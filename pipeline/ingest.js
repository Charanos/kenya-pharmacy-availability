/**
 * Raw scrape JSON -> validated observation rows.
 *
 * Two production concerns live here:
 *
 *   1. INPUT VALIDATION. The scrapers emit a bare 9-column array per product
 *      with no schema of its own (03_Scrapers/README.md). A column reordering
 *      upstream would otherwise be silently absorbed and corrupt every number
 *      downstream, so the shape is checked and a clear error is raised.
 *
 *   2. FAULT ISOLATION. One unreadable or malformed shop file degrades the run
 *      to 14 shops with a loud warning; it does not abort the build. This
 *      mirrors how run_all.py isolates each scraper in its own process, and it
 *      matters because a partial dashboard is useful and a failed build is not.
 *
 *   3. SCRAPE TIME. The scrapers write a sidecar <shop>.meta.json next to the
 *      rows carrying an ISO-8601 UTC `scraped_at` (03_Scrapers/common.py). That
 *      is the real observation time and it is what the time series is built on.
 *      When no sidecar is present -- a file captured before the scrapers
 *      stamped themselves -- the file's mtime is used instead and the row is
 *      flagged `snapshot_at_inferred`, because mtime is destroyed by any copy
 *      and must never be presented as a fact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROW_WIDTH, ROW_SHAPE } from './config.js';
import { buildMatchKey, repairUrl, readStockState, cleanText, nullish } from './normalize.js';

/** Rows sampled when checking that a file looks like what we expect. */
const SHAPE_SAMPLE = 50;

export class IngestError extends Error {}

/**
 * Confirm a parsed file is an array of 9-wide rows that look like products.
 * Returns a list of complaints; empty means it passed.
 */
export function validateShopFile(shopId, parsed) {
  const problems = [];

  if (!Array.isArray(parsed)) {
    problems.push(`expected a top-level array of rows, got ${typeof parsed}`);
    return problems;
  }
  if (parsed.length === 0) {
    problems.push('file contains zero rows');
    return problems;
  }

  const sample = parsed.slice(0, SHAPE_SAMPLE);
  const badWidth = sample.filter((r) => !Array.isArray(r) || r.length !== ROW_WIDTH).length;
  if (badWidth) {
    const example = sample.find((r) => !Array.isArray(r) || r.length !== ROW_WIDTH);
    problems.push(
      `${badWidth}/${sample.length} sampled rows are not ${ROW_WIDTH}-wide `
      + `(expected [${ROW_SHAPE.join(', ')}], saw ${Array.isArray(example) ? `${example.length} columns` : typeof example})`
    );
  }

  // Column 0 must be a non-empty product name and column 4 must be
  // price-shaped. If those two are wrong the columns have been reordered, and
  // that is the failure mode worth shouting about.
  const namesOk = sample.filter((r) => Array.isArray(r) && !nullish(r[0]) && typeof r[0] === 'string').length;
  if (namesOk < sample.length * 0.9) {
    problems.push(`column 0 does not look like a product name in ${sample.length - namesOk}/${sample.length} sampled rows`);
  }
  const priceOk = sample.filter((r) => {
    if (!Array.isArray(r)) return false;
    const v = r[4];
    return v === null || v === undefined || typeof v === 'number'
      || (typeof v === 'string' && /\d/.test(v)) || String(v) === 'nan';
  }).length;
  if (priceOk < sample.length * 0.9) {
    problems.push(`column 4 does not look like a price in ${sample.length - priceOk}/${sample.length} sampled rows`);
  }

  return problems;
}

/**
 * Pick the most stable per-shop listing identifier available.
 *
 * URL is right for 14 of the 15 September shops. Malibu embeds its whole
 * catalogue in one homepage document, so all 727 rows share a single URL and
 * keying on it would collapse the shop to one row. Choosing per shop and
 * recording the choice means a future broken URL pattern surfaces as a changed
 * strategy rather than as silently lost rows.
 */
export function chooseListingKey(rows) {
  const card = (fn) => new Set(rows.map(fn).filter(Boolean)).size;
  const n = rows.length;

  const byUrl = card((r) => (nullish(r[6]) ? null : String(r[6])));
  if (byUrl / n > 0.99) return { strategy: 'url', cardinality: byUrl };

  const bySku = card((r) => (nullish(r[8]) ? null : String(r[8])));
  if (bySku / n > 0.99) return { strategy: 'sku', cardinality: bySku };

  const byUrlName = card((r) => `${r[6]}||${r[0]}`);
  return { strategy: 'url+name', cardinality: byUrlName };
}

function listingIdFor(r, strategy) {
  if (strategy === 'url') return String(r[6]);
  if (strategy === 'sku') return String(r[8]);
  return `${r[6]}||${r[0]}`;
}

/**
 * Read <shop>.meta.json, the scrape-time sidecar.
 *
 * Returns `{ at, source, meta, problem }`. A sidecar that is missing, corrupt
 * or carries an unparseable timestamp is NOT fatal: the caller falls back to
 * mtime and flags the result as inferred. The reason is reported so a silently
 * broken sidecar shows up as a warning rather than as a plausible-looking date.
 */
export function readScrapeMeta(shopId, sourceDir) {
  const file = path.join(sourceDir, `${shopId}.meta.json`);
  if (!fs.existsSync(file)) return { at: null, source: 'absent', meta: null, problem: null };

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { at: null, source: 'unreadable', meta: null, problem: `${shopId}.meta.json is not valid JSON: ${err.message}` };
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { at: null, source: 'unreadable', meta: null, problem: `${shopId}.meta.json is not an object` };
  }

  const raw = meta.scraped_at ?? meta.scrape_started_at ?? null;
  if (!raw) {
    return { at: null, source: 'unreadable', meta, problem: `${shopId}.meta.json has no scraped_at` };
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    return { at: null, source: 'unreadable', meta, problem: `${shopId}.meta.json scraped_at is not a date: ${JSON.stringify(raw)}` };
  }
  // A scrape timestamp in the future is a clock or timezone bug upstream, and
  // trusting it would sort this snapshot ahead of every later one forever.
  if (at.getTime() > Date.now() + 86_400_000) {
    return { at: null, source: 'unreadable', meta, problem: `${shopId}.meta.json scraped_at is in the future: ${raw}` };
  }
  return { at, source: 'sidecar', meta, problem: null };
}

export function toPrice(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Read and convert one shop.
 *
 * Throws IngestError on a file that cannot be trusted; the caller decides
 * whether that is fatal for the run or just for this shop.
 */
export function ingestShop({ shopId, sourceDir, snapshotId, snapshotAt }) {
  const file = path.join(sourceDir, `${shopId}.json`);
  if (!fs.existsSync(file)) throw new IngestError(`${shopId}.json not found in ${sourceDir}`);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new IngestError(`${shopId}.json is not valid JSON: ${err.message}`);
  }

  const problems = validateShopFile(shopId, parsed);
  if (problems.length) throw new IngestError(`${shopId}.json failed validation — ${problems.join('; ')}`);

  // Prefer the scrapers' own timestamp. mtime is the fallback of last resort
  // and is always flagged, because a file copy resets it.
  const stat = fs.statSync(file);
  const scrapeMeta = readScrapeMeta(shopId, sourceDir);
  const at = snapshotAt ?? scrapeMeta.at ?? stat.mtime;
  const inferred = !snapshotAt && !scrapeMeta.at;

  const { strategy, cardinality } = chooseListingKey(parsed);

  const observations = [];
  const statuses = new Map();
  const seen = new Set();
  let inStock = 0, outOfStock = 0, unknown = 0, dupes = 0, skipped = 0, urlsRepaired = 0;

  for (const r of parsed) {
    if (!Array.isArray(r) || r.length !== ROW_WIDTH) { skipped++; continue; }

    const raw_name = cleanText(r[0]);
    if (!raw_name) { skipped++; continue; }

    const statusRaw = nullish(r[5]) ? null : String(r[5]).trim();
    statuses.set(statusRaw ?? '(missing)', (statuses.get(statusRaw ?? '(missing)') ?? 0) + 1);

    const state = readStockState(statusRaw);
    if (state === 'in_stock') inStock++;
    else if (state === 'out_of_stock') outOfStock++;
    else unknown++;

    const listing_id = listingIdFor(r, strategy);
    if (seen.has(listing_id)) dupes++;
    seen.add(listing_id);

    const { url, repaired } = repairUrl(r[6]);
    if (repaired) urlsRepaired++;

    const k = buildMatchKey(raw_name);

    observations.push({
      snapshot_id: snapshotId,
      snapshot_at: at.toISOString(),
      snapshot_at_inferred: inferred,
      pharmacy_id: shopId,
      listing_id,
      raw_name,
      canonical_name: k.canonical_name,
      category_raw: nullish(r[1]) ? null : cleanText(r[1]),
      brand_raw: nullish(r[2]) ? null : cleanText(r[2]),
      price_kes: toPrice(r[4]),
      currency: 'KES',
      stock_status_raw: statusRaw,
      stock_state: state,
      match_key: k.match_key,
      token_count: k.token_count,
      pack_sig: k.pack_sig,
      pack_kind: k.pack_kind,
      pack_value: k.pack_value,
      pack_unit: k.pack_unit,
      strength_sig: k.strength_sig,
      strength_value: k.strength_value,
      strength_unit: k.strength_unit,
      form: k.form,
      form_class: k.form_class,
      product_url: url,
      product_url_repaired: repaired,
      image_url: nullish(r[7]) ? null : String(r[7]),
      sku: nullish(r[8]) ? null : String(r[8]),
    });
  }

  return {
    observations,
    stats: {
      rows_in_file: parsed.length,
      rows_ingested: observations.length,
      rows_skipped: skipped,
      duplicate_listing_ids: dupes,
      urls_repaired: urlsRepaired,
      in_stock: inStock,
      out_of_stock: outOfStock,
      unknown_status: unknown,
      distinct_statuses: [...statuses.keys()],
      listing_key_strategy: strategy,
      listing_key_cardinality: cardinality,
      source_mtime: stat.mtime.toISOString(),
      snapshot_at: at.toISOString(),
      snapshot_at_inferred: inferred,
      snapshot_at_source: snapshotAt ? 'override' : scrapeMeta.source === 'sidecar' ? 'sidecar' : 'mtime',
      scrape_meta_problem: scrapeMeta.problem,
      scrape_finished_at: scrapeMeta.meta?.scrape_finished_at ?? null,
      scrape_duration_s: typeof scrapeMeta.meta?.duration_s === 'number' ? scrapeMeta.meta.duration_s : null,
    },
  };
}
