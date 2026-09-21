/**
 * DrugIndex reference data — loading, coverage measurement, fingerprinting.
 *
 * DRUGINDEX IS INCOMPLETE AND STILL BEING SCRAPED. Every design decision in
 * this module follows from that, and nothing downstream may assume otherwise:
 *
 *   - Missing files degrade the classifier, they do not crash the build. A run
 *     with no DrugIndex at all still produces a full dashboard, classified from
 *     shop categories and name rules alone.
 *   - Coverage is measured and published as data, so the dashboard can caveat
 *     the medicine filter instead of presenting it as authoritative.
 *   - Products that went unclassified *because* the reference data lacked them
 *     are marked `di_miss`, separately from products that are genuinely
 *     ambiguous. That number is the expected yield from finishing the scrape.
 *   - A content fingerprint tells you whether a rebuild would change anything,
 *     so `reclassify.js` can be run cheaply whenever DrugIndex grows.
 *
 * What is measurable about completeness today, from the September files:
 *   - Brand names span A-Z evenly, so the scrape is not truncated partway
 *   - `updated_at` spans 17 distinct days from 2026-04-19 to 2026-09-03, so it
 *     is accretive rather than a single pass
 *   - Field-level coverage is the real gap: 94.6% of brands carry an
 *     ingredient link, 79% of ingredients have indications, 39% have
 *     contraindications
 *   - The category hierarchy was orphaned until September 2026 — the scraper
 *     read the `categories` and `subcategories` tables but not the join tables
 *     holding the edges, so no ingredient carried a category_key and
 *     therapeutic class could not be derived at all. Fixed in
 *     03_Scrapers/scrape_drugindex.py; 77% of ingredients now link. The
 *     remainder are unlinked at source, not missed by the scrape.
 *
 * The true total is unknowable from inside, so nothing here reports a
 * "percent complete" against an assumed denominator. It reports what is
 * present, what is linked, and what the catalogue failed to match.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CLASSIFY } from './config.js';

export const DI_FILES = {
  brands: 'drugindex_brands.json',
  ingredients: 'drugindex_active_ingredients.json',
  categories: 'drugindex_categories.json',
  subcategories: 'drugindex_subcategories.json',
  manufacturers: 'drugindex_manufacturers.json',
  distributors: 'drugindex_distributors.json',
};

const clean = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/&#\d+;/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const share = (n, d) => (d ? Math.round((1000 * n) / d) / 1000 : null);

/**
 * Load whatever DrugIndex files are present.
 *
 * Never throws on a missing or unreadable file — it records the absence and
 * carries on, because a half-scraped reference set is the expected state.
 */
export function loadDrugIndex(dir) {
  const warnings = [];
  const files = {};
  const raw = {};

  for (const [key, filename] of Object.entries(DI_FILES)) {
    const file = path.join(dir, filename);
    if (!fs.existsSync(file)) {
      warnings.push(`${filename} absent — DrugIndex signal degraded for ${key}`);
      raw[key] = [];
      files[key] = { filename, present: false, bytes: 0, rows: 0 };
      continue;
    }
    try {
      const bytes = fs.statSync(file).size;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) {
        warnings.push(`${filename} is not an array — ignored`);
        raw[key] = [];
        files[key] = { filename, present: false, bytes, rows: 0 };
        continue;
      }
      raw[key] = parsed;
      files[key] = { filename, present: true, bytes, rows: parsed.length };
    } catch (err) {
      warnings.push(`${filename} failed to parse (${err.message}) — ignored`);
      raw[key] = [];
      files[key] = { filename, present: false, bytes: 0, rows: 0 };
    }
  }

  /* ------------------------------------------------------------ indexes */

  const ingredients = new Map();
  for (const a of raw.ingredients) if (a?.ai_key) ingredients.set(a.ai_key, a);

  const categories = new Map();
  for (const c of raw.categories) if (c?.category_key) categories.set(c.category_key, c);

  const subcategories = new Map();
  for (const s of raw.subcategories) if (s?.subcategory_key) subcategories.set(s.subcategory_key, s);

  const manufacturers = new Map();
  for (const m of raw.manufacturers) if (m?.manufacturer_key) manufacturers.set(m.manufacturer_key, m);

  const brands = new Map();
  let maxTokens = 1;
  for (const b of raw.brands) {
    const k = clean(b?.name);
    if (k.length < CLASSIFY.minBrandLength || brands.has(k)) continue;
    brands.set(k, {
      brand_key: b.brand_key,
      ai_key: b.ai_key ?? null,
      manufacturer_key: b.manufacturer_key ?? null,
      brand_name: b.name,
    });
    maxTokens = Math.max(maxTokens, k.split(' ').length);
  }

  // DrugIndex stores full registered product names, not bare brands: there is
  // no "Panadol" row, only "Panadol Advance" and "Panadol Baby And Infant", so
  // a listing reading "PANADOL 500MG 20S" misses on exact lookup. Index the
  // leading word as a weaker fallback.
  const brandHeads = new Map();
  for (const b of brands.values()) {
    const head = clean(b.brand_name).split(' ')[0];
    if (head.length < CLASSIFY.minBrandHeadLength || brandHeads.has(head)) continue;
    brandHeads.set(head, b);
  }

  // Single-word ingredient names only. Compounds are long descriptive strings
  // that never appear verbatim in a retail product name.
  const ingredientTokens = new Map();
  for (const a of ingredients.values()) {
    const k = clean(a.name);
    if (!k || k.includes(' ') || k.length < CLASSIFY.minIngredientTokenLength) continue;
    if (!ingredientTokens.has(k)) ingredientTokens.set(k, a);
  }

  /* ------------------------------------------------------------- stats */

  const brandRows = raw.brands.length;
  const ingredientRows = raw.ingredients.length;

  const updatedAt = raw.brands.map((b) => b?.updated_at).filter(Boolean).sort();
  const scrapeDays = new Set(updatedAt.map((t) => String(t).slice(0, 10)));

  const stats = {
    brands_rows: brandRows,
    brands_indexed: brands.size,
    brand_heads_indexed: brandHeads.size,
    brands_with_ingredient: raw.brands.filter((b) => b?.ai_key).length,
    brands_with_manufacturer: raw.brands.filter((b) => b?.manufacturer_key).length,
    ingredients_rows: ingredientRows,
    ingredient_tokens_indexed: ingredientTokens.size,
    ingredients_with_indications: raw.ingredients.filter((a) => a?.indications).length,
    ingredients_with_dosage: raw.ingredients.filter((a) => a?.dosage).length,
    ingredients_with_contraindications: raw.ingredients.filter((a) => a?.contraindications).length,
    categories_rows: raw.categories.length,
    subcategories_rows: raw.subcategories.length,
    manufacturers_rows: raw.manufacturers.length,
    distributors_rows: raw.distributors.length,
    ingredients_with_category: raw.ingredients.filter((a) => a?.category_key || a?.subcategory_key).length,
    subcategories_with_category: raw.subcategories.filter((s) => s?.category_key).length,
    earliest_updated_at: updatedAt[0] ?? null,
    latest_updated_at: updatedAt[updatedAt.length - 1] ?? null,
    distinct_scrape_days: scrapeDays.size,
  };

  // Ratios only ever measure linkage between things we hold. They never imply
  // a percentage of some unknown true total.
  const linkage = {
    brand_to_ingredient: share(stats.brands_with_ingredient, brandRows),
    brand_to_manufacturer: share(stats.brands_with_manufacturer, brandRows),
    ingredient_to_indications: share(stats.ingredients_with_indications, ingredientRows),
    ingredient_to_dosage: share(stats.ingredients_with_dosage, ingredientRows),
    ingredient_to_contraindications: share(stats.ingredients_with_contraindications, ingredientRows),
    ingredient_to_category: share(stats.ingredients_with_category, ingredientRows),
  };

  const missing = Object.entries(files).filter(([, f]) => !f.present).map(([k]) => k);

  if (stats.ingredients_with_category === 0 && ingredientRows > 0) {
    warnings.push(
      'therapeutic hierarchy is orphaned: no ingredient carries a category_key, '
      + 'so therapeutic_category is null for every product (fix in 03_Scrapers/scrape_drugindex.py)'
    );
  }
  if (brandRows === 0) {
    warnings.push('no DrugIndex brands loaded — classification falls back to shop categories and name rules only');
  }

  /* ------------------------------------------------------- fingerprint */

  // Identifies this exact reference set. If it has not changed, reclassifying
  // cannot change any result, so a rebuild can be skipped.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, [f.rows, f.bytes]])),
    latest: stats.latest_updated_at,
  })).digest('hex').slice(0, 16);

  return {
    brands, brandHeads, ingredients, ingredientTokens, manufacturers,
    categories, subcategories,
    maxTokens: Math.min(maxTokens, 4),
    files, stats, linkage, warnings, missing, fingerprint,
    available: brands.size > 0 || ingredientTokens.size > 0,
    loaded_at: new Date().toISOString(),
  };
}

/**
 * Therapeutic category name for an ingredient, or null.
 *
 * Resolves at the 21-category level rather than the 196-subcategory level:
 * that is the granularity a dashboard filter is usable at, and it is also the
 * more reliable of the two — an ingredient's category link comes straight from
 * `join_ai_and_categories`, whereas a subcategory's parent is inferred.
 *
 * The subcategory route is only a fallback for ingredients that carry a
 * subcategory link but no direct category link. Returns null rather than
 * guessing, so an unlinked ingredient stays visibly unlinked.
 */
export function therapeuticCategory(di, ai) {
  if (!ai || !di) return null;

  const direct = di.categories?.get(ai.category_key);
  if (direct?.name) return direct.name;

  const sub = di.subcategories?.get(ai.subcategory_key);
  const parent = di.categories?.get(sub?.category_key);
  return parent?.name ?? null;
}

/**
 * How much of the catalogue the reference set actually reached.
 *
 * This is the number that matters operationally: not "is DrugIndex complete"
 * (unknowable) but "how many of OUR products did it recognise", and how many
 * are still waiting on it.
 */
export function summariseCatalogueCoverage(productRows) {
  const total = productRows.length;
  const hit = productRows.filter((p) => p.di_brand_key || p.di_ai_key).length;
  const withIngredient = productRows.filter((p) => p.active_ingredient).length;
  const withIndications = productRows.filter((p) => p.indications).length;
  const gapDi = productRows.filter((p) => p.class_gap_reason === 'di_miss').length;
  const unclassified = productRows.filter((p) => p.product_type === 'unclassified').length;

  return {
    products_total: total,
    products_with_drugindex_match: hit,
    drugindex_match_rate: share(hit, total),
    products_with_active_ingredient: withIngredient,
    products_with_indications: withIndications,
    products_unclassified: unclassified,
    // Unclassified and carrying no usable shop category either: these are the
    // ones a more complete DrugIndex is most likely to resolve.
    products_awaiting_drugindex: gapDi,
    // Deliberately NOT a "percent complete". It is the share of the catalogue
    // whose classification is currently blocked on reference data.
    catalogue_blocked_on_drugindex: share(gapDi, total),
  };
}

/** One-line human summary for the build log. */
export function describeDrugIndex(di) {
  if (!di.available) return 'DrugIndex unavailable — classifying from shop categories and name rules only';
  return `DrugIndex ${di.fingerprint}: ${di.stats.brands_rows} brands (${di.brands.size} indexed, `
    + `${di.brandHeads.size} heads) · ${di.stats.ingredients_rows} ingredients `
    + `(${di.ingredientTokens.size} single-word) · latest ${String(di.stats.latest_updated_at ?? '—').slice(0, 10)}`;
}
