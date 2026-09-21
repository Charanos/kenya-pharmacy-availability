/**
 * Physical table schemas.
 *
 * Declared explicitly rather than left to DuckDB's JSON type inference,
 * because inference depends on the data it happens to see: a column that is
 * entirely null in one month's scrape infers a different type from the same
 * column populated the next month, and appending the second to the first then
 * fails or silently coerces. With multiple snapshots accumulating in one
 * table, a fixed schema is what keeps them comparable.
 *
 * Adding a column here is backward compatible. Removing or retyping one is a
 * breaking change to the dashboard contract: bump CONTRACT_VERSION in
 * config.js, which forces a full rebuild rather than an append.
 */

export const OBSERVATION = {
  snapshot_id: 'VARCHAR',
  snapshot_at: 'TIMESTAMP',
  snapshot_at_inferred: 'BOOLEAN',
  pharmacy_id: 'VARCHAR',
  listing_id: 'VARCHAR',
  raw_name: 'VARCHAR',
  canonical_name: 'VARCHAR',
  category_raw: 'VARCHAR',
  brand_raw: 'VARCHAR',
  price_kes: 'DOUBLE',
  currency: 'VARCHAR',
  stock_status_raw: 'VARCHAR',
  stock_state: 'VARCHAR',
  match_key: 'VARCHAR',
  match_algo_version: 'VARCHAR',
  token_count: 'INTEGER',
  pack_sig: 'VARCHAR',
  pack_kind: 'VARCHAR',
  pack_value: 'DOUBLE',
  pack_unit: 'VARCHAR',
  strength_sig: 'VARCHAR',
  strength_value: 'DOUBLE',
  strength_unit: 'VARCHAR',
  form: 'VARCHAR',
  form_class: 'VARCHAR',
  product_url: 'VARCHAR',
  product_url_repaired: 'BOOLEAN',
  image_url: 'VARCHAR',
  sku: 'VARCHAR',
  product_key: 'VARCHAR',
  match_confidence: 'DOUBLE',
  match_confidence_band: 'VARCHAR',
};

export const PRODUCT = {
  snapshot_id: 'VARCHAR',
  product_key: 'VARCHAR',
  canonical_name: 'VARCHAR',
  match_algo_version: 'VARCHAR',
  token_count: 'INTEGER',
  pack_sig: 'VARCHAR',
  pack_kind: 'VARCHAR',
  pack_value: 'DOUBLE',
  pack_unit: 'VARCHAR',
  strength_sig: 'VARCHAR',
  strength_value: 'DOUBLE',
  form: 'VARCHAR',
  form_class: 'VARCHAR',
  listings: 'INTEGER',
  pharmacies_listing: 'INTEGER',
  pharmacies_eligible: 'INTEGER',
  pharmacies_oos: 'INTEGER',
  pharmacies_in_stock: 'INTEGER',
  oos_share_of_eligible: 'DOUBLE',
  cluster_band: 'VARCHAR',
  match_confidence: 'DOUBLE',
  match_confidence_band: 'VARCHAR',
  match_price_cv: 'DOUBLE',
  match_flags: 'VARCHAR',
  review_state: 'VARCHAR',
  review_reason: 'VARCHAR',
  price_min: 'DOUBLE',
  price_median: 'DOUBLE',
  price_max: 'DOUBLE',
  product_type: 'VARCHAR',
  classifier_version: 'VARCHAR',
  class_confidence: 'DOUBLE',
  class_basis: 'VARCHAR',
  class_contested: 'BOOLEAN',
  class_gap_reason: 'VARCHAR',
  di_brand_key: 'VARCHAR',
  di_ai_key: 'VARCHAR',
  active_ingredient: 'VARCHAR',
  indications: 'VARCHAR',
  therapeutic_category: 'VARCHAR',
  drugindex_fingerprint: 'VARCHAR',
  is_clinical: 'BOOLEAN',
};

export const PHARMACY = {
  snapshot_id: 'VARCHAR',
  pharmacy_id: 'VARCHAR',
  name: 'VARCHAR',
  platform: 'VARCHAR',
  scrape_method: 'VARCHAR',
  robots_posture: 'VARCHAR',
  present_in_snapshot: 'BOOLEAN',
  absent_reason: 'VARCHAR',
  listings: 'INTEGER',
  rows_in_file: 'INTEGER',
  rows_skipped: 'INTEGER',
  listing_key_strategy: 'VARCHAR',
  listing_key_cardinality: 'INTEGER',
  duplicate_listing_ids: 'INTEGER',
  urls_repaired: 'INTEGER',
  in_stock: 'INTEGER',
  out_of_stock: 'INTEGER',
  unknown_status: 'INTEGER',
  distinct_status_values: 'INTEGER',
  publishes_oos: 'BOOLEAN',
  quarantined: 'BOOLEAN',
  health_score: 'DOUBLE',
  health_flags: 'VARCHAR',
  health_detail: 'VARCHAR',
  ingest_error: 'VARCHAR',
  last_success_at: 'TIMESTAMP',
};

export const DRUGINDEX_SNAPSHOT = {
  snapshot_id: 'VARCHAR',
  fingerprint: 'VARCHAR',
  loaded_at: 'TIMESTAMP',
  available: 'BOOLEAN',
  missing_files: 'VARCHAR',
  warnings: 'VARCHAR',
  brands_rows: 'INTEGER',
  brands_indexed: 'INTEGER',
  brand_heads_indexed: 'INTEGER',
  brands_with_ingredient: 'INTEGER',
  brands_with_manufacturer: 'INTEGER',
  ingredients_rows: 'INTEGER',
  ingredient_tokens_indexed: 'INTEGER',
  ingredients_with_indications: 'INTEGER',
  ingredients_with_dosage: 'INTEGER',
  ingredients_with_contraindications: 'INTEGER',
  ingredients_with_category: 'INTEGER',
  categories_rows: 'INTEGER',
  subcategories_rows: 'INTEGER',
  subcategories_with_category: 'INTEGER',
  manufacturers_rows: 'INTEGER',
  distributors_rows: 'INTEGER',
  earliest_updated_at: 'VARCHAR',
  latest_updated_at: 'VARCHAR',
  distinct_scrape_days: 'INTEGER',
  link_brand_to_ingredient: 'DOUBLE',
  link_brand_to_manufacturer: 'DOUBLE',
  link_ingredient_to_indications: 'DOUBLE',
  link_ingredient_to_dosage: 'DOUBLE',
  link_ingredient_to_contraindications: 'DOUBLE',
  link_ingredient_to_category: 'DOUBLE',
  products_total: 'INTEGER',
  products_with_drugindex_match: 'INTEGER',
  drugindex_match_rate: 'DOUBLE',
  products_with_active_ingredient: 'INTEGER',
  products_with_indications: 'INTEGER',
  products_unclassified: 'INTEGER',
  products_awaiting_drugindex: 'INTEGER',
  catalogue_blocked_on_drugindex: 'DOUBLE',
};

export const RUN_MANIFEST = {
  run_id: 'VARCHAR',
  snapshot_id: 'VARCHAR',
  started_at: 'TIMESTAMP',
  finished_at: 'TIMESTAMP',
  duration_ms: 'INTEGER',
  contract_version: 'VARCHAR',
  match_algo_version: 'VARCHAR',
  classifier_version: 'VARCHAR',
  drugindex_fingerprint: 'VARCHAR',
  source_dir: 'VARCHAR',
  shops_expected: 'INTEGER',
  shops_ingested: 'INTEGER',
  shops_failed: 'INTEGER',
  shops_absent: 'INTEGER',
  observations: 'INTEGER',
  products: 'INTEGER',
  warnings: 'VARCHAR',
  snapshot_at_inferred: 'BOOLEAN',
};

export const TABLES = {
  observation: OBSERVATION,
  product_snapshot: PRODUCT,
  pharmacy_snapshot: PHARMACY,
  drugindex_snapshot: DRUGINDEX_SNAPSHOT,
  run_manifest: RUN_MANIFEST,
};

/** `CAST(col AS TYPE) AS col, ...` — pins types regardless of JSON inference. */
export function castList(schema) {
  return Object.entries(schema)
    .map(([col, type]) => `CAST("${col}" AS ${type}) AS "${col}"`)
    .join(', ');
}

/** `"col" TYPE, ...` for a CREATE TABLE. */
export function columnList(schema) {
  return Object.entries(schema).map(([col, type]) => `"${col}" ${type}`).join(', ');
}
