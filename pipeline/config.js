/**
 * Tunables for the pipeline, in one place so that changing a threshold is a
 * config edit and a version bump rather than a hunt through the modules.
 *
 * Anything here that changes how a product is keyed or classified is stamped
 * onto the output rows, so a dashboard reading the data can always tell which
 * settings produced the numbers it is showing.
 */

export const CONTRACT_VERSION = '1.1.0';

/* --------------------------------------------------------------- matching */

export const MATCH = {
  /** Bare numbers up to this many digits are variant markers ("Wellman 50+"); longer runs are shop SKUs. */
  maxVariantNumberDigits: 3,
  /** Below this many distinct tokens a key is treated as weak evidence. */
  weakTokenCount: 1,
  /** Key strings shorter than this are treated as weak evidence. */
  minKeyLength: 8,
  /** Price coefficient of variation above which a group is probably over-merged. */
  priceCvSuspect: 0.6,
  priceCvSevere: 1.0,
  /** Tight prices across at least this many shops corroborate a weak key. */
  corroborationMinPharmacies: 3,
  corroborationMaxCv: 0.25,
  confidenceHigh: 0.8,
  confidenceMedium: 0.55,
};

/* --------------------------------------------------------- classification */

export const CLASSIFY = {
  /** Total evidence a type needs before we will name it at all. */
  evidenceThreshold: 3,
  /** Top two types within this margin are a genuine disagreement, not a decision. */
  contestedMargin: 1.5,
  /** DrugIndex brand names shorter than this match by coincidence. */
  minBrandLength: 4,
  /** Leading-word fallback needs at least this many characters to be meaningful. */
  minBrandHeadLength: 5,
  /** Single-word active-ingredient tokens shorter than this are too generic. */
  minIngredientTokenLength: 6,
  weights: {
    brandAtStart: 5,
    brandHead: 3.5,
    brandInner: 2.5,
    ingredientToken: 3,
    shopCategory: 4,
    doseFormOnly: 1,
  },
};

/* ----------------------------------------------------------- feed health */

export const FEED = {
  /** Fewer rows than this means the scrape failed, not that the shop is small. */
  minPlausibleRows: 100,
  /** Above this many rows, a single distinct stock value is not credible. */
  singleStatusRowFloor: 500,
  /** Share of unknown statuses that warrants a flag. */
  unknownStatusShare: 0.01,
  /** Run-over-run row count movement that indicates a scrape break. */
  rowCountDriftWarn: 0.2,
  /** In-stock rate movement in points that indicates a pipeline event. */
  rateDriftWarnPoints: 30,
};

/* ------------------------------------------------------------ input shape */

/** Column order every scraper emits. See 03_Scrapers/README.md. */
export const ROW_SHAPE = [
  'name', 'category', 'brand', 'characteristics',
  'price', 'stock_status', 'product_url', 'image_url', 'sku',
];
export const ROW_WIDTH = ROW_SHAPE.length;
