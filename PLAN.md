# Kenya Pharmacy Availability Dashboard — build plan

Author: Dennis · Drafted 21 September 2026
Numbers below were measured on 21 Sep 2026 from `04_Working Data/*.json` (the September scrape), not taken from the brief.

---

## 0. Read this first: the brief's numbers come from a different dataset

James's analysis describes **12 pharmacies / 52,475 listings / 56.6% in stock / 23 systemic OOS products**.
That is the **June or July** workbook. The September working data on disk says something different:

| Metric | James's note | Actual, Sept `04_Working Data` | Delta |
|---|---|---|---|
| Pharmacies | 12 | **15** | +3 |
| Catalogue listings | 52,475 | **51,350** | −1,125 |
| In-stock listings | 29,687 | **35,379** | |
| **Overall in-stock rate** | **56.6%** | **68.9%** | **+12.3 pts** |
| Unique normalized products | 48,044 | 46,439 | |
| **Systemic OOS (≥3 pharmacies)** | **23** | **1** | **−22** |
| Widely available (≥5) | 44 | 50 | |
| Median listed price | KES 1,450 | **KES 1,730** | +19% |
| Unknown-stock records | 105 | **0** | |
| Pharmily | **0%** | **75.9%** | fixed itself |
| Garnet | 22.7% | 25.1% | |

The shop list is not the same set either. September **has** HealthyU, Tims, Kalonji, Healthcart, Portal and
OneStop. September **is missing** Faiz, MyDawa and PharmaPlus — all three blocked by Sucuri or by the office
network at scrape time (`READ ME FIRST.txt`, item 2). PharmaPlus alone was 11,821 listings at 62.7% in June;
its absence is most of why September looks healthier.

**Consequence for the build:** do not hard-code 56.6%, or "23 systemic products", anywhere. Every figure is
computed from the fact table at render time, and every figure carries the scrape date and the shop roster it
was computed over. Two runs with different rosters are not comparable, and the UI has to say so out loud.

### September, measured — pharmacy league table

| Pharmacy | Listings | In stock | OOS | In-stock rate | Status values present |
|---|---:|---:|---:|---:|---|
| Garnet | 13,970 | 3,512 | 10,458 | 25.1% | In / Out |
| Pharmily | 7,244 | 5,497 | 1,747 | 75.9% | In / Out |
| HealthyU | 6,432 | 4,518 | 1,914 | 70.2% | In / Out |
| MedMarket | 4,899 | 4,899 | 0 | **100.0%** | In only |
| Goodlife | 4,266 | 3,564 | 702 | 83.5% | In / Out |
| Portal | 3,636 | 3,636 | 0 | **100.0%** | In only |
| Tims Nutrition | 3,303 | 3,195 | 108 | 96.7% | In / Out |
| Kalonji | 2,328 | 1,702 | 626 | 73.1% | In / Out |
| Rangechem | 1,114 | 1,038 | 76 | 93.2% | In / Out |
| Healthcart | 936 | 596 | 340 | 63.7% | In / Out |
| Hinata | 935 | 935 | 0 | **100.0%** | In only |
| Transwide | 852 | 852 | 0 | **100.0%** | In only |
| Malibu | 727 | 727 | 0 | **100.0%** | In only |
| Nila Pharm | 683 | 683 | 0 | **100.0%** | In only |
| OneStop | 25 | 25 | 0 | **100.0%** | In only — 25 rows, scrape is broken |

Seven feeds emit **exactly one** status value. That is not 100% availability, it is a feed that does not
publish an out-of-stock bit at all. Garnet contributes 27% of listings and **65% of every OOS row** in
September. OneStop returned 25 rows against a real catalogue — a failed scrape, not a small shop.

---

## 1. The finding that should drive the whole architecture

**The headline shortage metric is an artifact of the string-matching key, not of the market.**

`03_Scrapers/pharmacy_scrapbook_lib.py:296` matches products across shops using
`r[0].strip().upper()` — exact upper-cased name equality. I re-ran the cross-shop join on the same September
data under three different keys:

| Matching key | Distinct products | In ≥2 shops | In ≥3 | **OOS in ≥3** | Available in ≥5 |
|---|---:|---:|---:|---:|---:|
| A — current (`.strip().upper()`) | 46,222 | 2,971 | 601 | **1** | 50 |
| B — strip pack/unit tokens, token-sort | 37,658 | 4,911 | 1,554 | **10** | 221 |
| C — B truncated to 3 sorted tokens | 32,720 | 5,669 | 1,964 | **31** | 319 |

The core alert number moves **1 → 10 → 31** with no change whatsoever to the underlying data. Under key A only
**6.0%** of products appear in more than one shop — meaning 94% of the catalogue is invisible to any
cross-pharmacy question. James read the low dedup ratio (1.09) as "normalization is decent"; it actually means
the join is barely firing.

So the product-resolution engine is not a preprocessing detail. It is **the product**. It gets a versioned
algorithm ID, a per-match confidence score, a strictness control in the UI, and a review queue for near
misses. Any number on screen that depends on it is labelled with the key that produced it.

Second-order check: under key B the top cross-shop OOS items are Tampax Pearl, Johnson's Baby Oil, a Dr Organic
face mask, Solgar and NOW supplements. James is right — **unfiltered, this is an FMCG dashboard wearing a
pharmacy costume.** The medicine filter has to be on by default, not a toggle someone might find.

### The classification spine is already on disk

`04_Working Data/drugindex_*.json` — the brief never spotted that this is the class map it asks for:

- `drugindex_brands.json` — **5,599** brand names, each keyed to an active ingredient and a manufacturer
- `drugindex_active_ingredients.json` — **2,409** ingredients with indications, dosage, contraindications, side effects
- `drugindex_categories.json` (21) and `drugindex_subcategories.json` (196) — therapeutic class
- `drugindex_manufacturers.json` (635), `drugindex_distributors.json` (99) — with addresses, for supply-side attribution

Measured join coverage against the 46,439 unique catalogue names: brand match at name start **13.2%**,
anywhere in the name **+3.1%** (16.3% combined), active-ingredient token **9.4%**. A real spine, but not
sufficient alone — it needs a dose-form and keyword rules layer on top to reach usable precision. Budget real
work here; this is not a clean SQL join.

---

## 2. Tooling — decided, with reasons

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| Transform | **DuckDB** (CLI → Parquet) | Reads the raw JSON directly, SQL over 51k rows in milliseconds, emits Parquet. Note: **Python is not on this machine's PATH** (only the Windows Store stubs) while Node 24 and npm are — a pandas pipeline is not runnable here today without an install. |
| Delivery | **Parquet shipped to the browser + DuckDB-WASM** | 51k rows compresses to a few MB. The entire dataset goes client-side and the dashboard runs its own SQL. **No API, no server, no database to host, no backend to secure.** This single choice deletes roughly 40% of the build. Revisit only past ~50 snapshots. |
| App | **Vite + React + TypeScript** | Static build, deploys anywhere. Not Next.js — there is no server to justify it. |
| Charts | **Observable Plot**, plus hand-written SVG for the two hero figures | Recharts and Chart.js defaults *are* the slop look — the rounded bars, the auto-legend, the stock palette. Plot is grammar-of-graphics: every mark is a deliberate choice. |
| Tables | **TanStack Table** (headless) | Logic only, zero imposed styling. These tables are dense and custom. |
| Styling | **Plain CSS + a token file. No component library.** | shadcn/ui over default Tailwind greys with `rounded-xl` and a gradient heading is the exact generic-AI signature to avoid. Hand-built primitives on tokens. |
| URL state | **nuqs**, or hand-rolled searchParams sync | Every filter combination is a shareable URL. Non-negotiable for an analyst tool. |
| Fonts | UI **Geist Sans** or **IBM Plex Sans**; all numerals in **Geist Mono / IBM Plex Mono** with `font-variant-numeric: tabular-nums` | Inter is the default-choice tell. Tabular figures are mandatory — proportional digits in a data table is the loudest amateur signal there is. |

All of the above is MIT or OFL, free.

---

## 3. Data architecture

### 3.1 Fact table — does not exist yet, and must

```
observation(
  snapshot_id, snapshot_at,        -- STAMP EVERY RUN. Today's JSON carries no timestamp.
  pharmacy_id, pharmacy_name,
  listing_id,                      -- stable per shop: the product URL
  raw_name, category_raw, brand_raw,
  price_kes, currency,
  stock_status_raw,                -- keep the original string, always
  stock_state,                     -- enum: in_stock | out_of_stock | not_published
  product_key, match_algo_version, match_confidence,
  product_url, image_url, sku
)
```

Two rules that are easy to get wrong and expensive to fix later:

1. **`not_published` is not `out_of_stock`.** A feed that never emits an OOS bit — the seven 100% shops —
   must not be counted as positive evidence of availability. Today's 68.9% silently does exactly that.
2. **Append, never overwrite.** Each run is a new `snapshot_id`. This is the one change that turns a
   spreadsheet into a time series, and every interesting metric — new stockouts, days out of stock, recovery
   time, price moves, feed volatility — is unreachable until it happens. Do it on run #1, not run #5.

### 3.2 Dimensions

```
pharmacy(pharmacy_id, name, platform, scrape_method, robots_posture,
         last_success_at, feed_health_score)

product(product_key, canonical_name, pack_size, form, di_brand_key, di_ai_key,
        product_type, therapeutic_category, is_paediatric, review_state)

  product_type ∈ {medicine, device, supplement, cosmetic, sexual_wellness, food, unclassified}
  review_state ∈ {auto, confirmed, needs_review}
```

Passival, Pantogar and anything the classifier scores below threshold land in `needs_review` and are
**excluded from the pharma view** until a human clears them. An uncertain classification is not a silent guess.

### 3.3 Feed health — a gate, not a badge

A pharmacy is **quarantined from all network-level KPIs** (still visible on its own page, clearly marked) when:

- it emits a single distinct stock value across more than 500 rows → *publishes no OOS signal*
- its row count moves more than ±20% run over run → *scrape break*
- its row count collapses below a floor (OneStop at 25) → *scrape failure*
- its in-stock rate moves more than ±30 points in one run → *pipeline event, not a health event*

Quarantine is **reversible and visible**: a drawer lists every quarantined feed, the rule it tripped, and what
the headline would be if it were included. Publishing "Pharmily: 0%" as an empty warehouse was always wrong,
and September proves it — the same shop reads 75.9% a month later.

### 3.4 Cluster bands

`1 = isolated · 2 = local · 3–4 = cluster · 5–9 = systemic · 10–14 = national · 15+ = total`

Code all six now. September's ceiling is 3 of 15 under the current key. The bands are what give the number
meaning as the panel grows, and they stop a 3/3 being reported in the same voice as a 12/15.

---

## 4. Design doctrine — how this avoids looking generated

The generic-AI-dashboard look is a specific, identifiable set of moves. Name them, then ban them.

**Banned outright**

- A four-across row of equal-weight KPI cards with huge numbers and an emoji or lucide icon each
- Purple/indigo-to-pink gradients; gradient text; glassmorphism; `backdrop-blur`
- Donuts, pies, 3D, gradient-filled area charts, drop shadows on data marks
- Uniform `rounded-xl` on everything; the default Tailwind grey ramp
- Traffic-light red/amber/green sprayed across every metric
- Proportional-figure numerals in any table or KPI
- Any number without a denominator, a date and a unit
- "AI Insights" panels of generated prose

**The aesthetic instead: instrument, not poster.**

The visual language to reference is a Bloomberg terminal, the FT and Economist data desks, and Linear's
density — editorial, typographic, monochrome-dominant, one accent, high information per pixel.

**Tokens**

```
Surface   #FAFAF8 paper / #14161A ink        (warm neutral, not blue-grey)
Text      #1A1D21 primary · #5C636E secondary · #8B929E tertiary
Rule      #E4E2DD hairline, 1px — used liberally; rules replace cards
Accent    ONE colour, ink-blue #2B4C7E, used only for the active/selected state
Data ramp 5-step sequential for availability, low → high; never red-green
Alert     Amber #B8730A, reserved exclusively for data-quality quarantine
Radius    2px everywhere (4px on the single modal)
Shadow    none — elevation is expressed through rules and spacing
```

**Type scale** — 11 / 13 / 15 / 20 / 32 on a 4pt baseline grid, 8pt spacing scale. Numerals in mono with
tabular figures, right-aligned in tables, decimal-aligned. Headings in sentence case at normal weight; no
ALL-CAPS tracking-wide label above every block.

**Hierarchy** — one hero figure per screen, not six equal ones. On the overview that hero is availability by
pharmacy with quarantine state shown in the mark itself; the KPI strip is **secondary**, set small and
typographic in a single ruled row rather than as cards.

**The provenance rule, applied to every figure on screen:**

```
  68.9%   in stock
  ────────────────────────────────────────
  35,379 of 51,350 listings · 15 pharmacies
  7 feeds publish no OOS bit  ⚑
  scraped 3 Sep 2026 · key: B/v2
```

Value, denominator, roster, caveat, date, algorithm. A KPI without those is decoration. This is also the
honest answer to "56.6% is a lie" — the dashboard does not bury the caveat in a footnote, it sets it in the
same block as the number.

---

## 5. Layout

Twelve-column grid, 72px max gutter, 1440 content max-width, comfortable from 1280 up. The left rail is
navigation only — the filter bar is horizontal and sticky under the header, because filters are the primary
interaction and burying them in a sidebar is what makes these dashboards feel dead.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Kenya Pharmacy Availability          Snapshot: 3 Sep 2026 ▾   15 pharmacies│  56px, ruled
├────────────────────────────────────────────────────────────────────────────┤
│ View: ● Medicines ○ All SKUs   Feeds: ● Healthy only ○ All   Match: B ▾    │  44px, sticky
├────────────────────────────────────────────────────────────────────────────┤
│ 68.9% in stock │ 51,350 listings │ 46,439 products │ 10 systemic │ KES 1,730│  one ruled row
│ ⚑ 7 feeds publish no OOS bit · 3 pharmacies missing vs August              │  amber, one line
├──────────────────────────────────────────┬─────────────────────────────────┤
│  HERO — availability by pharmacy         │  DATA QUALITY                   │
│  horizontal bars, sorted, hatched fill   │  quarantined feeds, the rule    │
│  where the feed publishes no OOS bit     │  each tripped, headline delta   │
│  8 rows visible, rest on scroll          │  if it were included            │
├──────────────────────────────────────────┴─────────────────────────────────┤
│  CROSS-PHARMACY SHORTAGE SIGNAL                            band: cluster ▾ │
│  product · band · OOS n/listed · class · substitute · match confidence     │
│  dense table, 14 rows, sparkline column once history exists                │
├────────────────────────────────────────────────────────────────────────────┤
│  BROADEST COVERAGE            │  PRICE DISTRIBUTION      │  MATCH QUALITY  │
│  small multiples              │  log-x histogram with    │  match rate by  │
│                               │  the median ruled in     │  key: A / B / C │
└────────────────────────────────────────────────────────────────────────────┘
```

Four screens, not a five-tab sprawl:

1. **Overview** — the above.
2. **Product** — one product across every pharmacy. Price spread, who stocks it, the substitute set derived
   from the active-ingredient graph, the DrugIndex monograph (indications, contraindications, side effects —
   already in the data and currently unused), plus the raw name each shop used and the match confidence for
   each one.
3. **Pharmacy** — one shop. Catalogue composition, availability by therapeutic class, feed-health history,
   scrape method and robots posture, price index against the panel median.
4. **Data quality** — the quarantine drawer promoted to a screen. Per-feed row counts over time, status-value
   cardinality, match-rate diagnostics, and the `needs_review` classification queue.

The drill path is one continuous thread: **KPI → pharmacy bar → product row → product page → every listing
with its live URL.** No dead ends, and every leaf links out to the real pharmacy product page.

---

## 6. Build order

| # | Step | Ships |
|---|---|---|
| 1 | DuckDB transform: 15 JSON files → `observation` Parquet, `snapshot_at` stamped, `not_published` separated from `out_of_stock` | the fact table |
| 2 | Matching engine v1 (key B), versioned, per-match confidence, keys persisted | `product_key` |
| 3 | DrugIndex join + dose-form rules → `product_type`, therapeutic class, `needs_review` queue | the medicine filter |
| 4 | Feed-health rules and quarantine flags | honest denominators |
| 5 | Vite shell, token system, type scale, primitives (Rule, Figure, DataTable, ProvenanceBlock) | the look |
| 6 | Overview: KPI strip, pharmacy hero, DQ panel | first real screen |
| 7 | Shortage table with bands, substitutes, confidence | the reason it exists |
| 8 | Product and Pharmacy screens, full drill-through | the thread |
| 9 | Data-quality screen and match-review queue | trust |
| 10 | Snapshot #2 → deltas, sparklines, new-stockout feed | the time series |

Steps 1–4 are the real work and carry all the risk. Steps 5–9 go fast **because** 1–4 exist. Resist starting
at 5: a beautiful shell over an unresolved matching key is exactly how this ends up a poster.

---

## 7. Open questions for James

1. **Roster.** September is 15 shops, his analysis is 12, his brief says "10." Which roster is the product? Do
   Faiz, MyDawa and PharmaPlus get unblocked before launch, or does the dashboard ship without them and say
   so? This changes every headline number on the screen.
2. **Audience.** Retail and distributor commercial tool, patient-facing "who has this near me", or
   regulator-facing? Those are three different products. This plan assumes commercial/analyst — a
   patient-facing build would lead with search rather than KPIs, and would need a licensed-outlet check given
   the current PPB recall climate.
3. **Cadence.** Monthly is what the scrapers support today. Weekly makes recovery-time and volatility metrics
   real. Daily needs infrastructure nobody has scoped.
4. **Publishing 100% and 0%.** Naming a specific pharmacy as "0% available" on a shareable screen is a
   commercial and reputational claim about a real business, made from a scrape that has already been wrong
   once. Recommendation: quarantined feeds show as *"no stock signal published"*, never as a rate.
5. **The three blockers.** The README's advice stands — ask PharmaPlus for a feed rather than crawling 644
   collection pages, and ask Faiz and MyDawa to whitelist the office IP. A supplied feed beats a scraper on
   every axis, including the legal one.
