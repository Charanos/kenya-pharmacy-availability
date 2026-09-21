/**
 * Product classification.
 *
 * Answers the question the whole dashboard depends on: is this a medicine, or
 * is it shampoo? Unfiltered, the September cross-pharmacy shortage signal is
 * face masks and lecithin, which is not a medicine-access story.
 *
 * Three independent signals, scored as evidence rather than applied as a
 * cascade, so that disagreement stays visible instead of being silently
 * resolved by whichever rule happened to run first:
 *
 *   1. DrugIndex brand / active-ingredient match  (precise, INCOMPLETE)
 *   2. The shop's own category label              (good recall, noisy)
 *   3. Name keyword and dose-form rules           (fallback, always available)
 *
 * DrugIndex is still being scraped, so signal 1 is expected to strengthen over
 * time while 2 and 3 stay constant. Two consequences are built in here:
 *
 *   - The classifier runs correctly with no DrugIndex at all. Signals 2 and 3
 *     carry it, at reduced precision.
 *   - Every unclassified product records WHY. `di_miss` means the reference
 *     data is the binding constraint and finishing the scrape should resolve
 *     it; `ambiguous` means the signals genuinely conflict and more reference
 *     data will not help. Only the first number should be expected to fall.
 *
 * Anything below the evidence threshold stays `unclassified` rather than being
 * guessed into a bucket.
 */

import { CLASSIFY } from './config.js';
import { therapeuticCategory } from './drugindex.js';

export const CLASSIFIER_VERSION = 'cls/v2';

export const PRODUCT_TYPES = [
  'medicine', 'supplement', 'device', 'cosmetic',
  'personal_care', 'sexual_wellness', 'food', 'unclassified',
];

/** Types that belong in the default "medicines and devices" dashboard view. */
export const CLINICAL_TYPES = new Set(['medicine', 'device']);

/** Why a product did not come out cleanly classified. */
export const GAP_REASONS = ['contested', 'ambiguous', 'di_miss'];

const clean = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/&#\d+;/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Longest brand n-gram in a name, preferring one anchored at the start. */
function findBrand(tokens, di) {
  if (!di?.available || !tokens.length) return null;

  // Tried in descending order of anchoring strength, which is also descending
  // weight. Checking the unanchored `inner` case before the anchored `head`
  // case would let a weaker interpretation preempt a stronger one: growing the
  // reference set then *demoted* 11 products out of `medicine`, because a new
  // mid-name coincidence (2.5) was found before the leading-word match (3.5)
  // that had been carrying them.
  for (let len = Math.min(di.maxTokens, tokens.length); len >= 1; len--) {
    const hit = di.brands.get(tokens.slice(0, len).join(' '));
    if (hit) return { ...hit, position: 'start', span: len };
  }
  // DrugIndex holds full registered names ("Panadol Advance"), not bare
  // brands, so a listing reading "PANADOL 500MG 20S" needs this fallback.
  const head = di.brandHeads.get(tokens[0]);
  if (head) return { ...head, position: 'head', span: 1 };

  for (let i = 1; i < tokens.length; i++) {
    for (let len = Math.min(di.maxTokens, tokens.length - i); len >= 1; len--) {
      const hit = di.brands.get(tokens.slice(i, i + len).join(' '));
      if (hit) return { ...hit, position: 'inner', span: len };
    }
  }
  return null;
}

/* ------------------------------------------------------------- lexicons */

// Applied to the shop's own category label. First match per label wins, so
// specific patterns sit above general ones.
const CATEGORY_RULES = [
  [/sexual|condom|family planning|intimate|contracept/, 'sexual_wellness'],
  [/equipment|machine|device|mobility|first aid|bandage|diagnostic|surgical|orthop|wheelchair|walking aid/, 'device'],
  [/dental|oral care|hygiene|toiletr|sanitary|diaper|nappy|household|tissue|deodor/, 'personal_care'],
  [/food|drink|beverage|grocer|snack|free from|confection|tea|coffee/, 'food'],
  [/sports nutrition|amino|bcaa|protein|vitamin|supplement|supplimen|nutrition|tonic|herbal|ayurved|probiotic|wellness/, 'supplement'],
  [/beauty|skin ?care|skincare|cosmetic|hair care|hair ?loss|make ?up|fragrance|perfume|nail|body care|sun ?care|grooming/, 'cosmetic'],
  [/prescription|counter medicinal|over the counter|\botc\b|medicine|medicinal|pharmaceutic|antibiotic|analgesic|antimalaria|antiprotozoa|antifungal|antiviral|antihistamin|cardio|diabet|respiratory|dermatolog|ophthalm|gastro|urolog|neurolog|oncolog/, 'medicine'],
  // Real categories that say nothing about product type.
  [/mother|baby|maternity|infant|paediatric|pediatric/, null],
];

/** Category labels that carry no information at all. */
const EMPTY_CATEGORIES = new Set(['uncategorized', 'uncategorised', 'general', 'other', 'misc', 'all']);

// Applied to the product name. Strong rules are near-decisive nouns; moderate
// rules are suggestive and expected to be outvoted by an explicit category.
const NAME_RULES = [
  [/\b(condoms?|durex|lubricant|pleasure ring|vibrat)\b/, 'sexual_wellness', 4],
  [/\b(thermometer|nebuli[sz]er|spacer|syringe|glucometer|glucose meter|test strips?|bandages?|plasters?|crutch|wheelchair|walking stick|bp monitor|blood pressure monitor|stethoscope|catheter|cannula|nitrile|latex gloves?|face shield|pulse oximeter|weighing scale|hot water bottle|ice pack|cold pack|compression|sling|splint)\b/, 'device', 4],
  [/\b(toothpaste|toothbrush|mouthwash|dental|oral rinse|deodorant|antiperspirant|roll ?on|sanitary (pads?|towels?)|tampons?|diapers?|nappies|wet wipes?|baby wipes?|cotton wool|toilet (roll|paper)|razors?|shaving)\b/, 'personal_care', 4],
  // Shops that file their whole catalogue under "Uncategorized" leave the name
  // as the only signal, and baby toiletries were the largest single block of
  // unclassified products: Epimax, Sebamed, Cetaphil, Johnson's.
  [/\bbaby\b.*\b(lotion|cream|oil|soap|powder|wash|bath|shampoo|jelly|rub)\b/, 'personal_care', 3.5],
  [/\b(shampoos?|conditioners?|cleansers?|moisturi[sz]|body wash|shower gel|face mask|facial scrub|mascara|lipstick|foundation|concealer|toner|sunscreen|sunblock|spf|anti ?ageing|anti ?aging|serum|nail polish|(body|hand|face|skin|foot) (lotion|cream|butter|oil|scrub))\b/, 'cosmetic', 3],
  [/\b(lotions?|body butter)\b/, 'cosmetic', 2.5],
  [/\b(multivitamins?|vitamins?|omega ?3|cod liver|fish oil|collagen|probiotics?|whey|protein powder|creatine|glucosamine|spirulina|evening primrose|folic acid)\b/, 'supplement', 3],
  [/\b(juice|cereal|honey|flour|biscuits?|chocolate|coffee|herbal tea|infant formula|growing up (milk|formula))\b/, 'food', 3],
  // What the product treats. DrugIndex is Kenya's prescription register and
  // carries little of the OTC shelf -- no Benylin, Vicks, Amroid, Epimax -- so
  // a large slice of it has to be recognised from its own name. This rule is
  // what keeps the classifier useful while the reference scrape is unfinished.
  [/\b(cough|cold ?&? ?flu|flu|fever|antipyretic|pain relief|painkiller|analgesic|antiseptic|disinfectant|antifungal|antibacterial|antihistamine|allerg|laxative|antacid|heartburn|indigestion|diarrhoea|diarrhea|dewormer|anthelmint|malaria|haemorrhoid|hemorrhoid|decongestant|expectorant|vapou?r ?rub|vaporub|chest rub|inhalant|teething|rehydration|ors)\b/, 'medicine', 3],
  // Forms that are essentially only ever medicinal, kept separate from tablets
  // and capsules below, which supplements use just as heavily.
  [/\b(syrups?|suspensions?|injections?|suppositor|ampoules?|infusions?|eye drops?|ear drops?|nasal (spray|drops?)|inhalers?|lozenges?|emulsions?)\b/, 'medicine', 3],
  [/\b(tablets?|capsules?)\b/, 'medicine', 1.5],
];

/* ----------------------------------------------------------- classifier */

/**
 * @param name        display name for the product
 * @param categories  every distinct category_raw its listings carried
 * @param form        dose form extracted by normalize.js, if any
 * @param di          index from loadDrugIndex(); may be unavailable
 */
export function classify({ name, categories = [], form = null, di = null }) {
  const W = CLASSIFY.weights;
  const tokens = clean(name).split(' ').filter(Boolean);
  const scores = Object.fromEntries(PRODUCT_TYPES.map((t) => [t, 0]));
  const basis = [];

  /* -- signal 1: DrugIndex (incomplete, may be absent entirely) --------- */
  const brand = findBrand(tokens, di);
  let brandAi = null;
  if (brand) {
    const w = brand.position === 'start' ? W.brandAtStart
      : brand.position === 'head' ? W.brandHead
        : W.brandInner;
    scores.medicine += w;
    basis.push(`drugindex brand "${brand.brand_name}" (${brand.position})`);
    if (brand.ai_key) brandAi = di.ingredients.get(brand.ai_key) ?? null;
  }

  // The ingredient scan runs even when a brand already matched, because the
  // two are independent evidence and Kenyan retail names routinely carry both:
  // "AZITHROMYCIN 250MG (MAZIT)", "CEFIXIME 200 DT (RAINCEF) 10S".
  //
  // Short-circuiting here was actively harmful. Growing the reference set
  // would surface a weak mid-name brand hit (2.5, below the evidence
  // threshold) that suppressed the generic-name hit (3) previously carrying
  // the product, so ADDING data demoted four antibiotics out of `medicine`.
  // More reference data must never classify less.
  let ingredientHit = null;
  if (di?.available) {
    for (const t of tokens) {
      const hit = di.ingredientTokens.get(t);
      if (hit) { ingredientHit = hit; break; }
    }
  }
  if (ingredientHit) {
    scores.medicine += W.ingredientToken;
    basis.push(`active ingredient "${ingredientHit.name}" in name`);
  }

  // Prefer the brand's linked ingredient for provenance -- it is an explicit
  // DrugIndex relationship rather than a name-token coincidence.
  const ai = brandAi ?? ingredientHit;
  const diHit = Boolean(brand || ai);

  /* -- signal 2: the shop's own category -------------------------------- */
  // Scored once per type however many shops agree: five shops filing something
  // under "beauty" is one opinion repeated, not five independent ones.
  const catTypes = new Set();
  let sawUsableCategory = false;
  for (const c of categories) {
    const cc = clean(c);
    if (!cc || EMPTY_CATEGORIES.has(cc)) continue;
    for (const [re, type] of CATEGORY_RULES) {
      if (re.test(cc)) {
        sawUsableCategory = true;
        if (type) catTypes.add(type);
        break;
      }
    }
  }
  for (const t of catTypes) {
    scores[t] += W.shopCategory;
    basis.push(`shop category -> ${t}`);
  }

  /* -- signal 3: name keywords and dose form ---------------------------- */
  const lower = clean(name);
  const nameTypes = new Set();
  for (const [re, type, w] of NAME_RULES) {
    if (nameTypes.has(type)) continue;
    if (re.test(lower)) {
      nameTypes.add(type);
      scores[type] += w;
      basis.push(`name keyword -> ${type}`);
    }
  }
  if (form && !nameTypes.has('medicine')) {
    scores.medicine += W.doseFormOnly;
    basis.push(`dose form "${form}"`);
  }

  /* -- resolve ----------------------------------------------------------- */
  const ranked = PRODUCT_TYPES
    .filter((t) => t !== 'unclassified')
    .map((t) => [t, scores[t]])
    .sort((a, b) => b[1] - a[1]);

  const [topType, topScore] = ranked[0];
  const [, runnerScore] = ranked[1];

  const monograph = {
    di_brand_key: brand?.brand_key ?? null,
    di_ai_key: ai?.ai_key ?? null,
    active_ingredient: ai?.name ?? null,
    indications: ai?.indications ?? null,
    // One of DrugIndex's 21 top-level categories, reached through the matched
    // ingredient. Null where the product matched no ingredient, or where the
    // ingredient is not itself filed under a category upstream — both are
    // ordinary states, not failures.
    therapeutic_category: therapeuticCategory(di, ai),
    // Records which reference set produced the fields above, so a later
    // reclassify can tell what is stale.
    drugindex_fingerprint: di?.fingerprint ?? null,
  };

  if (topScore < CLASSIFY.evidenceThreshold) {
    return {
      product_type: 'unclassified',
      classifier_version: CLASSIFIER_VERSION,
      class_confidence: 0,
      class_basis: basis.join(' · ') || 'no signal',
      class_contested: false,
      // The distinction that makes the reference-data backlog measurable:
      // no DrugIndex hit AND no usable shop category means this product is
      // waiting on the scrape, not genuinely ambiguous.
      class_gap_reason: (!diHit && !sawUsableCategory) ? 'di_miss' : 'ambiguous',
      ...monograph,
    };
  }

  // A near-tie between two types is a real disagreement between signals --
  // "Vitamin C Serum" filed under skin care, "Wellman Capsules" in a dose
  // form. Surface it rather than letting a half-point margin decide silently.
  const contested = runnerScore >= CLASSIFY.evidenceThreshold
    && (topScore - runnerScore) < CLASSIFY.contestedMargin;

  return {
    product_type: topType,
    classifier_version: CLASSIFIER_VERSION,
    class_confidence: Math.min(1, Math.round((topScore / (topScore + runnerScore)) * 1000) / 1000),
    class_basis: basis.join(' · '),
    class_contested: contested,
    class_gap_reason: contested ? 'contested' : null,
    ...monograph,
  };
}
