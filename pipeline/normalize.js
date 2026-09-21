/**
 * Product name normalization and match-key construction.
 *
 * This is the heart of the dashboard. The cross-pharmacy shortage metric is a
 * direct function of what this file decides is "the same product", so every
 * decision here is versioned and every output carries a confidence score.
 *
 * Measured on the September 2026 scrape, the choice of key moves the headline
 * "out of stock in >=3 pharmacies" count from 1 (exact upper-case match, which
 * is what pharmacy_scrapbook_lib.py:296 does today) to 31 (aggressive
 * 3-token truncation). Neither extreme is honest. See MATCH_ALGO_VERSION.
 */

export const MATCH_ALGO_VERSION = 'B/v2';

/* ------------------------------------------------------------------ text */

const ENTITIES = {
  '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>',
  '&nbsp;': ' ', '&reg;': '', '&trade;': '', '&deg;': ' ',
};

/** Decode the HTML entities the scrapers leave in place (&#8217;, &#038;, ...). */
export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      // Curly quotes and dashes become their ASCII equivalents, not literals,
      // so "JOHNSON'S" and "JOHNSON’S" produce the same tokens.
      if (code === 8216 || code === 8217) return "'";
      if (code === 8220 || code === 8221) return '"';
      if (code === 8211 || code === 8212) return '-';
      return String.fromCharCode(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => (m.toLowerCase() in ENTITIES ? ENTITIES[m.toLowerCase()] : ' '));
}

/** The scrapers write the Python string "nan" for missing values. */
export function nullish(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'nan' || s === 'none' || s === 'null' || s === 'n/a';
}

export function cleanText(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------- pack / strength / form */

// Volume and weight of the container. Everything is carried to a canonical
// unit so 1L, 1000ml and 1 ltr collapse to the same signature.
const VOLUME = { ml: 1, mls: 1, l: 1000, ltr: 1000, ltrs: 1000, litre: 1000, litres: 1000, liter: 1000 };
const WEIGHT = { g: 1, gm: 1, gms: 1, gr: 1, kg: 1000, kgs: 1000, oz: 28.35, lb: 453.6 };
// Potency of the active ingredient. Deliberately separate from pack: 500mg is
// a strength, 500g is a pack weight, and merging them merges different products.
const STRENGTH = { mcg: 0.001, ug: 0.001, mg: 1, g: 1000, iu: null, '%': null };

const COUNT_WORDS = 's|pcs|pc|pieces|tabs|tab|tablets|tablet|caps|cap|capsules|capsule|sachets|sachet|softgels|softgel|lozenges|vials|ampoules|wipes|pads|rolls|bags|sticks|strips|doses';

const FORMS = [
  [/\b(tablets?|tabs?|caplets?)\b/, 'tablet'],
  [/\b(capsules?|caps?|softgels?)\b/, 'capsule'],
  [/\b(syrups?)\b/, 'syrup'],
  [/\b(suspensions?|susp)\b/, 'suspension'],
  [/\b(creams?)\b/, 'cream'],
  [/\b(ointments?)\b/, 'ointment'],
  [/\b(gels?)\b/, 'gel'],
  [/\b(lotions?)\b/, 'lotion'],
  [/\b(drops?)\b/, 'drops'],
  [/\b(sprays?)\b/, 'spray'],
  [/\b(injections?|inj)\b/, 'injection'],
  [/\b(solutions?|soln)\b/, 'solution'],
  [/\b(powders?)\b/, 'powder'],
  [/\b(sachets?)\b/, 'sachet'],
  [/\b(suppositories|suppository)\b/, 'suppository'],
  [/\b(patch(es)?)\b/, 'patch'],
  [/\b(shampoos?)\b/, 'shampoo'],
  [/\b(soaps?)\b/, 'soap'],
  [/\b(serums?)\b/, 'serum'],
  [/\b(mouthwash(es)?)\b/, 'mouthwash'],
  [/\b(emulsions?)\b/, 'emulsion'],
];

// Forms that can never be the same product as each other. Used to split a
// match group that a name-token key wrongly merged. Cosmetic-ish forms are
// left out: "serum" vs "gel" is not a reliable split signal.
const FORM_CONFLICT_CLASS = {
  tablet: 'solid_oral', capsule: 'solid_oral',
  syrup: 'liquid_oral', suspension: 'liquid_oral', solution: 'liquid_oral',
  cream: 'topical', ointment: 'topical', lotion: 'topical',
  injection: 'parenteral',
  drops: 'drops', spray: 'spray', suppository: 'suppository', patch: 'patch',
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Pull the container size out of a name.
 * Returns e.g. { kind: 'volume', ml: 200, sig: 'v200' }.
 */
export function extractPack(lower) {
  const vol = lower.match(new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(VOLUME).join('|')})\\b`));
  if (vol) {
    const n = parseFloat(vol[1].replace(',', '.')) * VOLUME[vol[2]];
    return { kind: 'volume', value: round3(n), unit: 'ml', sig: `v${round3(n)}` };
  }
  const wt = lower.match(new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${Object.keys(WEIGHT).join('|')})\\b`));
  if (wt) {
    const n = parseFloat(wt[1].replace(',', '.')) * WEIGHT[wt[2]];
    return { kind: 'weight', value: round3(n), unit: 'g', sig: `w${round3(n)}` };
  }
  // "30's", "30s", "60 tablets", "10S" -- a count of units in the pack.
  const cnt = lower.match(new RegExp(`\\b(\\d+)\\s*'?\\s*(${COUNT_WORDS})\\b`));
  if (cnt) {
    const n = parseInt(cnt[1], 10);
    // A bare "s" suffix on a 1-2 digit number is a count ("10s"); on a long
    // number it is noise, so require something plausible.
    if (n > 0 && n <= 5000) return { kind: 'count', value: n, unit: 'units', sig: `c${n}` };
  }
  return null;
}

/** Pull the active-ingredient potency out of a name: 500mg, 5mcg, 1000iu, 4%. */
export function extractStrength(lower) {
  const pct = lower.match(/\b(\d+(?:[.,]\d+)?)\s*%/);
  if (pct) {
    const n = parseFloat(pct[1].replace(',', '.'));
    return { value: n, unit: '%', sig: `p${round3(n)}` };
  }
  const iu = lower.match(/\b(\d+(?:[.,]\d+)?)\s*iu\b/);
  if (iu) {
    const n = parseFloat(iu[1].replace(',', '.'));
    return { value: n, unit: 'iu', sig: `i${round3(n)}` };
  }
  const m = lower.match(/\b(\d+(?:[.,]\d+)?)\s*(mcg|ug|mg)\b/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.')) * STRENGTH[m[2]];
    return { value: round3(n), unit: 'mg', sig: `s${round3(n)}` };
  }
  return null;
}

export function extractForm(lower) {
  for (const [re, name] of FORMS) if (re.test(lower)) return name;
  return null;
}

export function formConflictClass(form) {
  return form ? (FORM_CONFLICT_CLASS[form] ?? null) : null;
}

/* ------------------------------------------------------------- match key */

// Removed before keying. Only words that never distinguish one product from
// another: dose forms (captured separately as `form`), packaging nouns, and
// connectors. Brand-ish words such as "plus", "forte", "junior", "extra" and
// "max" are deliberately NOT here -- "Febrex Plus" is not "Febrex".
const STOPWORDS = new Set([
  'tablets', 'tablet', 'tabs', 'tab', 'caplet', 'caplets',
  'capsules', 'capsule', 'caps', 'cap', 'softgel', 'softgels',
  'syrup', 'syrups', 'suspension', 'susp', 'solution', 'soln',
  'cream', 'ointment', 'gel', 'lotion', 'drops', 'drop', 'spray',
  'injection', 'inj', 'powder', 'sachet', 'sachets', 'suppository',
  'ml', 'mls', 'l', 'ltr', 'ltrs', 'litre', 'litres', 'liter',
  'g', 'gm', 'gms', 'gr', 'kg', 'kgs', 'oz', 'lb',
  'mg', 'mcg', 'ug', 'iu',
  'pcs', 'pc', 'pieces', 'piece', 'pack', 'packs', 'packet', 'box',
  'bottle', 'tube', 'jar', 'tin', 'each', 'unit', 'units',
  'the', 'and', 'for', 'with', 'of', 'in', 'by', 'to', 'a', 'an', 'x',
]);

/**
 * Build the cross-pharmacy match key.
 *
 * Shape:  "<sorted distinctive tokens>#<pack sig>#<strength sig>"
 *
 * Pack and strength are stripped out of the token stream (so "200ml", "200 ml"
 * and "200mls" stop being three different tokens) and then appended back as a
 * canonical signature. That is the crucial difference from a naive
 * units-stripped key, which happily merges Scotts Emulsion Orange 100ml with
 * the 200ml bottle -- two products with different prices and different
 * availability.
 */
export function buildMatchKey(rawName) {
  const name = cleanText(rawName);
  const lower = name.toLowerCase();

  const pack = extractPack(lower);
  const strength = extractStrength(lower);
  const form = extractForm(lower);

  const tokens = lower
    // Drop every number-plus-unit run; pack/strength already captured them.
    .replace(new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s*(${Object.keys(VOLUME).join('|')}|${Object.keys(WEIGHT).join('|')}|mcg|ug|mg|iu)\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b\\d+\\s*'?\\s*(${COUNT_WORDS})\\b`, 'g'), ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => {
      if (!t || STOPWORDS.has(t)) return false;
      // Any bare number still standing has survived measurement stripping, so
      // it is a variant marker, not a size: the 50 in "Wellman 50+", the 1 in
      // "NAN 1", the 3 in "Aptamil 3". Dropping these merged eight shops'
      // worth of different Wellman products into one KES 1,852-4,440 blob.
      // Long runs are shop-internal codes ("Sun Lotion (6575)") and would
      // block genuine matches instead, so they still go.
      if (/^\d+$/.test(t)) return t.length <= 3;
      return t.length > 1;
    });

  const distinct = [...new Set(tokens)].sort();

  return {
    canonical_name: name,
    tokens: distinct,
    token_count: distinct.length,
    pack_sig: pack?.sig ?? null,
    pack_kind: pack?.kind ?? null,
    pack_value: pack?.value ?? null,
    pack_unit: pack?.unit ?? null,
    strength_sig: strength?.sig ?? null,
    strength_value: strength?.value ?? null,
    strength_unit: strength?.unit ?? null,
    form,
    form_class: formConflictClass(form),
    match_key: distinct.length
      ? `${distinct.join(' ')}#${pack?.sig ?? '-'}#${strength?.sig ?? '-'}`
      : null,
  };
}

/* ----------------------------------------------------------- confidence */

/**
 * Confidence that every listing sharing a match_key really is one product.
 *
 * Only meaningful for groups spanning more than one pharmacy -- a single-shop
 * group makes no cross-pharmacy claim, so nothing downstream depends on its
 * score. Components are returned alongside the score so the review queue can
 * show *why* a match is doubtful rather than just a number.
 */
export function scoreGroup({ tokenCount, keyLength, hasPack, hasStrength, prices, pharmacyCount }) {
  const reasons = [];
  let score = 1;

  if (tokenCount <= 1) { score *= 0.6; reasons.push('single-token key'); }
  else if (tokenCount === 2) { score *= 0.85; reasons.push('two-token key'); }

  if (keyLength < 8) { score *= 0.75; reasons.push('very short key'); }

  if (!hasPack && !hasStrength && pharmacyCount > 1) {
    score *= 0.85;
    reasons.push('no pack size or strength to verify against');
  }

  // Wide price dispersion across shops for a supposedly identical product is
  // the strongest available signal that the key over-merged.
  let cv = null;
  const valid = prices.filter((p) => typeof p === 'number' && p > 0);
  if (valid.length > 1) {
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const sd = Math.sqrt(valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length);
    cv = mean > 0 ? sd / mean : 0;
    if (cv > 1.0) { score *= 0.55; reasons.push(`price spread cv=${cv.toFixed(2)}`); }
    else if (cv > 0.6) { score *= 0.75; reasons.push(`price spread cv=${cv.toFixed(2)}`); }
    // Tight prices across three or more independent shops is positive evidence
    // that a weak-looking key is nonetheless right. Coldcap Syrup 100ml keys on
    // one token but sells for KES 149-300 in seven shops; that is one product.
    else if (cv < 0.25 && pharmacyCount >= 3) {
      score *= 1.25;
      reasons.push(`corroborated by tight prices cv=${cv.toFixed(2)}`);
    }
  }

  score = Math.max(0, Math.min(1, score));
  return {
    score: Math.round(score * 1000) / 1000,
    price_cv: cv === null ? null : Math.round(cv * 1000) / 1000,
    band: score >= 0.8 ? 'high' : score >= 0.55 ? 'medium' : 'low',
    reasons,
  };
}

/* --------------------------------------------------------- misc repairs */

/**
 * Portal Pharmacy's scraper emits a product_id parameter containing another
 * full URL plus the pagination arg, e.g.
 *   .../index.php?route=product/product&product_id=https://portalpharmacy.ke/x?limit=100
 * The embedded URL is the real product page. Repair it here so drill-through
 * links work, and flag it so the scraper gets fixed upstream too.
 */
export function repairUrl(url) {
  if (nullish(url)) return { url: null, repaired: false };
  let u = String(url).trim();
  const nested = u.match(/product_id=(https?:\/\/[^\s&]+)/);
  if (nested) return { url: nested[1].replace(/\?limit=\d+$/, ''), repaired: true };
  return { url: u, repaired: false };
}

/** Map a shop's raw stock string onto the literal reading. No judgement here. */
export function readStockState(raw) {
  if (nullish(raw)) return 'unknown';
  const s = String(raw).toLowerCase();
  if (s.includes('out of stock') || s.includes('outofstock') || s.includes('sold out')) return 'out_of_stock';
  if (s.includes('in stock') || s.includes('instock') || s.includes('available')) return 'in_stock';
  return 'unknown';
}
