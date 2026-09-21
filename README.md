# Kenya Pharmacy Availability — data pipeline

Turns the raw shop scrapes in `04_Working Data/` into a fact table, a matching
engine, a classification layer and Parquet read models.

**If you are building against this, read [CONTRACT.md](CONTRACT.md).** That is
the frozen surface between the backend and the dashboard, and `verify.js`
asserts it on every build.

```bash
npm install
npm run build       # raw JSON -> data/*.parquet + data/kpad.duckdb
npm run verify      # 75 assertions, non-zero exit on failure
npm run export:app  # project the views into the browser read model
npm run dev         # run the interface at localhost:5173
npm run reclassify  # re-score classification after the DrugIndex scrape grows
npm run ci          # strict build + verify + export + production bundle
```

## Architecture

```
04_Working Data/*.json
        |
   ingest.js ......... validation, fault isolation, listing identity
        |
   normalize.js ...... match key: tokens # pack signature # strength signature
        |
   build.js .......... dose-form splits, confidence scoring, cluster bands
        |
   classify.js ....... 3-signal evidence ensemble  <- drugindex.js
        |
   schema.js ......... declared types, multi-snapshot append
        |
   data/kpad.duckdb + data/*.parquet
```

| Module | Responsibility |
|---|---|
| `config.js` | every tunable threshold, plus `CONTRACT_VERSION` |
| `schema.js` | declared physical types — not inferred from JSON |
| `ingest.js` | input validation, per-shop fault isolation, listing identity |
| `normalize.js` | match-key construction, pack/strength/form extraction, confidence |
| `drugindex.js` | reference data: loading, coverage, fingerprinting |
| `classify.js` | product type from three independent signals |
| `build.js` | orchestration, matching, views, manifest |
| `reclassify.js` | classification-only re-run when the reference set grows |
| `verify.js` | 75 assertions across unit, structure, semantics and contract |
| `export-app.js` | projects the views into the columnar browser read model |

## Interface

```
src/
  app.css                design tokens — no component hardcodes a colour
  lib/store.js           columnar loader, typed arrays, bitmask index
  lib/filters.js         predicate engine, cross-filtered facet counts, URL state
  components/charts.jsx  hand-built SVG: bars, mix, price curve, coverage,
                         matrix, bands, linkage, confidence
  components/ui.jsx      primitives, inline icon set, windowed list
  views/                 Overview · Catalogue · Sources · Quality
```

**89 KB of JS, 4.5 KB of CSS, 3.07 MB of data, all gzipped.** There is no query
engine in the browser: 43,606 products filter in about a millisecond as a
single integer pass over typed arrays, so every keystroke re-filters, re-counts
every facet and redraws every chart with no debounce and no worker.

Three design decisions worth knowing:

- **Bitmask presence.** Fifteen pharmacies fit in a `uint16`, so each product
  carries three masks — listed, in stock, out of stock. Every per-source
  filter, the availability matrix and the coverage plot read those directly.
- **Cross-filtered facet counts.** A facet's own dimension is excluded when
  counting it, so the number beside each option means "how many you would get
  if you picked this", not "how many are showing now". Counting naively is what
  makes most filter panels feel broken.
- **Every figure carries its provenance.** Value, denominator, roster, caveat,
  date and algorithm version sit in the same block as the number. Quarantined
  feeds are rendered as hatched bars with no rate, never as "100% available".

## The five decisions that shape the numbers

**1. `stock_evidence` is not `stock_state`.** The fact table records what each
shop literally said. The judgement — that a feed emitting one status value
across thousands of rows is not reporting 100% availability, it is not
reporting at all — lives in a view, so it stays re-derivable and arguable.
Seven September feeds are in that position. Gating them moves the headline from
**68.9% to 59.7%**.

**2. The shortage ceiling is 8, not 15.** Only 8 feeds publish an out-of-stock
bit, so no product can cluster above 8 in this snapshot.
`product.pharmacies_eligible` carries that denominator.

**3. The match key keeps pack size and strength.** Shape is
`<sorted distinctive tokens>#<pack sig>#<strength sig>`. Stripping units so
`200ml`, `200 ml` and `200mls` stop being three tokens is necessary; the trap is
leaving them stripped, which merges Scotts Emulsion Orange 100ml with the 200ml
bottle. They go back on as a canonical signature.

**4. Bare numbers are variant markers.** Dropping them merged seven shops' worth
of Wellman 50+, Original, 70+ and Conception into one product spanning
KES 1,852–4,440. Numbers of 1–3 digits are kept; longer runs are shop codes and
would block genuine matches, so those still go.

**5. Confidence is a group property with visible reasons.** Short keys, missing
pack/strength and wide price dispersion push a group down; tight prices across
3+ independent shops pull it back up, which is how Coldcap Day Time — a
single-token key — correctly scores high.

## The number that changed

"Out of stock in ≥3 pharmacies", same September data:

| Key | Count |
|---|---:|
| `.strip().upper()` (`pharmacy_scrapbook_lib.py:296`) | 1 |
| B/v2, all products | 2 |
| **B/v2, clinical products only** | **0** |

The brief's **23 systemic shortages** does not survive honest matching plus a
medicine filter. The two products reaching 3 pharmacies are NOW Lecithin
Granules (a supplement) and a Dr Organic face mask. At ≥2 pharmacies there are
48 clinical products, 36 of them confidently matched — that is
`shortage_signal`, and it is what the dashboard should lead with.

## DrugIndex is incomplete, and the pipeline is built for that

The reference scrape is unfinished and accretive — 17 distinct scrape days
between April and September. Nothing here assumes otherwise:

- **It runs without DrugIndex at all.** Medicine classification falls from 25.8%
  to 15.4% and the coverage view says so. No crash, no empty dashboard.
- **Gaps are attributed.** 9,164 products (21.0%) are unclassified *because the
  reference data lacks them* (`class_gap_reason = 'di_miss'`); only 662 (1.5%)
  are genuinely ambiguous. Only the first number should be expected to fall.
  `drugindex_backlog` lists them, most-listed first.
- **Growth is cheap to absorb.** Matching does not depend on DrugIndex, so
  `npm run reclassify` re-scores in place in ~2 seconds instead of re-ingesting
  51,350 rows. It no-ops when the reference fingerprint is unchanged.
- **Growth is monotonic.** More reference data never classifies fewer products.
  Asserted in `verify.js`; it regressed once, when a weak mid-name brand match
  suppressed a generic-name match and demoted four antibiotics.
- **Coverage is published as data, never as "percent complete."** The true
  total is unknowable from inside. `drugindex_coverage` reports linkage between
  records we hold and how much of *our* catalogue was reached.

One structural gap remains in the reference data:

- **It is a prescription register.** No Benylin, Vicks, Amroid or Epimax, so the
  OTC shelf is recognised from indications written into product names
  (`cough`, `flu`, `antiseptic`, `vaporub`) rather than from a join.

The therapeutic hierarchy used to be the other one. It was orphaned because
the scraper read the `categories` and `subcategories` tables but not the join
tables holding the edges between them — the hierarchy is many-to-many, and
`subcategories.category_key` is NULL on every row at source, which made a
missing scrape look like a missing column. Fixed September 2026: 77% of
ingredients now carry a category, and `therapeutic_category` reaches 58.5% of
clinical products across 19 classes. The remaining 23% are unfiled upstream,
so they will not come back with a re-scrape.

## Operational guarantees

Idempotent re-runs · per-shop fault isolation · validated input shape ·
declared types · multi-snapshot append · run manifest · consumer-contract
assertions. All exercised in `verify.js`; details in
[CONTRACT.md](CONTRACT.md#guarantees).

## Known limitations

- `snapshot_at` is **still inferred from file mtime for the September data**.
  The scrapers now stamp every run in a `<shop>.meta.json` sidecar
  (`03_Scrapers/common.py`) and the pipeline prefers it, but the September
  files predate the sidecar, so this snapshot is flagged `snapshot_at_inferred`
  until those shops are re-scraped. Copy `<shop>.meta.json` into
  `04_Working Data/` alongside `<shop>.json`, or the fallback kicks in again.
- Single snapshot so far. Trend views are live but empty until a second run.
- PharmaPlus, Faiz and MyDawa are absent (network / Sucuri WAF). They are
  carried as explicit rows so the denominator change is visible.
- OneStop returned 25 rows against a real catalogue — quarantined as a failed
  scrape, not a small shop.
