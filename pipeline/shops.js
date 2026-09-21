/**
 * Pharmacy registry. Platform, scrape method and robots posture are taken from
 * 03_Scrapers/README.md; they belong on the dashboard because "why is this
 * feed like this" is the first question anyone asks about a suspicious number.
 */

export const SHOPS = {
  garnet:     { name: 'Garnet Pharmacy',   platform: 'WooCommerce', method: 'Store API',              robots: 'ok' },
  goodlife:   { name: 'Goodlife Pharmacy', platform: 'WooCommerce', method: 'Store API',              robots: 'ok' },
  transwide:  { name: 'Transwide',         platform: 'WooCommerce', method: 'Store API',              robots: 'ok' },
  onestop:    { name: 'OneStop Pharmacy',  platform: 'WooCommerce', method: 'Store API',              robots: 'ok' },
  tims:       { name: 'Tims Nutrition',    platform: 'WooCommerce', method: 'Store API (Cloudflare)', robots: 'ok' },
  malibu:     { name: 'Malibu Pharmacy',   platform: 'Siternity',   method: 'homepage arr_results JS', robots: 'ok' },
  pharmily:   { name: 'Pharmily',          platform: 'Laravel',     method: 'paginated HTML (Cloudflare)', robots: 'ok' },
  nilapharm:  { name: 'Nila Pharm',        platform: 'Django',      method: 'paginated HTML',         robots: 'ok' },
  rangechem:  { name: 'Rangechem',         platform: 'SvelteKit',   method: 'full server-render',     robots: 'ok' },
  medmarket:  { name: 'MedMarket',         platform: 'custom',      method: 'XHR loadProducts',       robots: 'ok' },
  hinata:     { name: 'Hinata Pharmacy',   platform: 'Botble CMS',  method: 'paginated HTML',         robots: 'ok' },
  kalonji:    { name: 'Kalonji',           platform: 'Shopify',     method: 'products.json feed',     robots: 'ok' },
  healthcart: { name: 'Healthcart',        platform: 'Shopify',     method: 'products.json feed',     robots: 'ok' },
  portal:     { name: 'Portal Pharmacy',   platform: 'OpenCart',    method: 'sitemap + category pages', robots: 'ok' },
  healthyu:   { name: 'HealthyU',          platform: 'Angular SPA', method: 'sitemap + JSON API',     robots: 'ok' },
};

/**
 * Shops that are part of the panel but produced no data in this snapshot.
 * They are carried explicitly so the dashboard can say "3 pharmacies missing"
 * instead of silently shrinking the denominator -- which is most of why the
 * September in-stock rate looks better than June's.
 */
export const ABSENT = {
  pharmaplus: { name: 'PharmaPlus', reason: 'unreachable from this network', last_seen: '2026-06', last_listings: 11821 },
  faiz:       { name: 'Faiz Pharmacy', reason: 'Sucuri WAF blocks office IP (BLACK02)', last_seen: '2026-06', last_listings: null },
  mydawa:     { name: 'MyDawa', reason: 'Sucuri WAF blocks office IP (BLACK02)', last_seen: '2026-06', last_listings: null },
};

/* ------------------------------------------------------- feed health rules */

/** Row count below this means the scrape failed, not that the shop is small. */
export const MIN_PLAUSIBLE_ROWS = 100;
/** Above this many rows, a feed emitting one single stock value is not credible. */
export const SINGLE_STATUS_ROW_FLOOR = 500;

/**
 * Decide whether a feed's stock signal can be trusted, and why not.
 *
 * The distinction this encodes is the one the current workbook misses: a shop
 * that never emits "Out of Stock" is not a shop at 100% availability, it is a
 * shop that does not publish the bit. Counting it as positive evidence is what
 * inflates the network in-stock rate.
 */
export function assessFeed({ rows, distinctStatuses, inStock, outOfStock, unknown }) {
  const flags = [];
  let publishes_oos = true;
  let quarantined = false;

  if (rows < MIN_PLAUSIBLE_ROWS) {
    flags.push({ rule: 'implausible_row_count', detail: `${rows} rows` });
    quarantined = true;
    publishes_oos = false;
  }

  if (outOfStock === 0 && rows >= SINGLE_STATUS_ROW_FLOOR) {
    flags.push({ rule: 'no_oos_signal', detail: `${distinctStatuses.length} distinct status value(s) over ${rows} rows` });
    publishes_oos = false;
    quarantined = true;
  }

  if (unknown / Math.max(rows, 1) > 0.01) {
    flags.push({ rule: 'high_unknown_status', detail: `${unknown} unknown of ${rows}` });
  }

  if (inStock === 0 && rows >= SINGLE_STATUS_ROW_FLOOR) {
    flags.push({ rule: 'zero_availability', detail: 'feed reports nothing in stock' });
    quarantined = true;
  }

  return {
    publishes_oos,
    quarantined,
    flags,
    // 1.0 clean, 0 unusable. Shown as a bar, never as a letter grade.
    health_score: Math.max(0, 1 - flags.length * 0.34),
  };
}
