# Data contract — backend to interface

**Contract version 1.1.0.** The surface between the pipeline and anything that
reads it. Anything listed here is frozen: it will gain columns, never lose or
retype them without a major version bump.

`pipeline/verify.js` asserts every view and column on this page exists on every
build (the `CONTRACT` group), so a backend change fails the build rather than
surfacing as a runtime error in a consumer.

---

## Input: what the scrapers hand over

Per shop, two files in `04_Working Data/`:

| File | Shape |
|---|---|
| `<shop>.json` | bare top-level array of 9-column rows, see `03_Scrapers/README.md` |
| `<shop>.meta.json` | `{"scraped_at": "<ISO-8601 UTC>", ...}` — when that scrape ran |

The sidecar is the authority for `snapshot_at`. It is optional: a shop without
one falls back to its `.json` file's mtime and every row it produced is flagged
`snapshot_at_inferred`. **mtime is not a timestamp** — any copy, sync or
restore resets it — so an inferred snapshot is never presented to a user as a
fact, and a whole build is flagged if any single shop is inferred.

A sidecar that exists but is corrupt, timestamp-less or dated in the future is
ignored *with a warning* rather than trusted; a plausible-looking wrong date is
worse than an admitted guess, because the entire time series is indexed on it.

## Read this first: three properties of the data

**1. The DrugIndex reference scrape is unfinished.** Product classification is
therefore provisional and improves over time. **21% of products (9,164) are
unclassified specifically because the reference data does not cover them yet**,
versus 1.5% that are genuinely ambiguous. Do not present the medicine filter as
authoritative — `drugindex_coverage` exists so the UI can caveat it. Expect
`products_awaiting_drugindex` to fall as the scrape progresses.

**2. Only 8 of 15 feeds publish an out-of-stock bit.** The other 7 emit a single
stock value for their whole catalogue, which is not 100% availability — it is a
feed that does not report. Use `in_stock_rate_gated`, not
`in_stock_rate_raw`, and use `pharmacies_eligible` as the denominator for
"out of stock in N pharmacies". The raw rate is 68.9%; the honest one is 59.7%.

**3. Snapshots accumulate.** Every view named below resolves to the **latest
snapshot only**, so your queries stay correct when a second month lands. History
is in the `*_history` and `*_trend` views. Nothing you write needs to change
when snapshot #2 arrives.

---

## Where the data lives

**Backend (authoritative).** DuckDB and Parquet in `data/`. This is where the
views below live and where any new analysis should be written.

| Artifact | Size | Use |
|---|---:|---|
| `data/kpad.duckdb` | 18 MB | everything, all snapshots, all views |
| `data/observation.parquet` | 4.8 MB | every listing, latest snapshot |
| `data/product.parquet` | 2.0 MB | resolved products with match + class |
| `data/pharmacy.parquet` | 6 KB | feed health and metadata |
| `data/drugindex_coverage.parquet` | 7 KB | reference-data coverage |

**Browser read model.** `npm run export:app` projects the views below into
`static/app/`, columnar and dictionary-encoded:

| File | Raw | Gzipped | When it loads |
|---|---:|---:|---|
| `meta.json` | 0.16 MB | **0.05 MB** | first — shell and every headline figure |
| `products.json` | 7.22 MB | 1.51 MB | second — the grid |
| `listings.json` | 5.51 MB | 1.51 MB | background — per-source detail |
| **total** | 12.9 MB | **3.07 MB** | |

> **DuckDB-WASM was removed from the browser.** The MVP bundle is a 41 MB
> WebAssembly download before first pixel, to query 43,606 rows — and 43,606
> rows is nothing for JavaScript. A full predicate sweep over every column runs
> in about a millisecond against typed arrays, so the engine was buying query
> expressiveness we get for free and charging a first paint for it. The whole
> app is now 89 KB of JS and 4.5 KB of CSS gzipped. DuckDB stays on the
> backend, where it is genuinely the right tool.
>
> The move that carries the UI: 15 pharmacies fit in a `uint16`, so each
> product's presence is three bitmasks — listed, in stock, out of stock. Every
> per-source filter, the availability matrix and the coverage charts read those
> masks with no join and no per-listing scan.

---

## Views

All of these are in `data/kpad.duckdb`. Latest-snapshot unless marked history.

### `kpi_headline` — one row, the top strip

| Column | Type | Notes |
|---|---|---|
| `snapshot_id` | VARCHAR | e.g. `S2026-09` |
| `snapshot_at` | TIMESTAMP | the scrapers' own `scraped_at`, or file mtime — see `snapshot_at_inferred` |
| `snapshot_at_inferred` | BOOLEAN | true if **any** shop in the snapshot fell back to mtime |
| `listings` | INTEGER | 51,350 |
| `products` | INTEGER | 43,606 distinct resolved products |
| `pharmacies` | INTEGER | 15 present |
| `pharmacies_publishing_oos` | INTEGER | **8** — the shortage-signal ceiling |
| `in_stock` / `out_of_stock` / `not_published` | INTEGER | sum to `listings` |
| `in_stock_rate_gated` | DOUBLE | **59.7 — use this one** |
| `in_stock_rate_raw` | DOUBLE | 68.9 — for the sensitivity toggle only |
| `median_price_kes` | DOUBLE | 1,730 |

### `pharmacy` — one row per shop, 15 present + 3 absent

`pharmacy_id`, `name`, `platform`, `scrape_method`, `robots_posture`,
`present_in_snapshot`, `absent_reason`, `listings`, `rows_in_file`,
`rows_skipped`, `listing_key_strategy`, `listing_key_cardinality`,
`duplicate_listing_ids`, `urls_repaired`, `in_stock`, `out_of_stock`,
`unknown_status`, `distinct_status_values`, `publishes_oos`, `quarantined`,
`health_score`, `health_flags`, `health_detail`, `ingest_error`,
`last_success_at`.

`quarantined` means excluded from network KPIs, with `health_detail` giving the
human reason. **Do not render a quarantined feed as a rate.** Show
"no stock signal published". Pharmily read 0% in June and 75.9% in September —
publishing that as an empty warehouse would have been wrong both times.

Rows with `present_in_snapshot = false` are PharmaPlus, Faiz and MyDawa, absent
for the reasons in `absent_reason`. Carry them in the UI so the denominator
change is visible rather than silent.

### `product` — one row per resolved product

Identity and shape: `product_key`, `canonical_name`, `form`, `form_class`,
`pack_sig`, `pack_kind`, `pack_value`, `pack_unit`, `strength_sig`,
`strength_value`, `token_count`.

Presence: `listings`, `pharmacies_listing`, **`pharmacies_eligible`**,
`pharmacies_oos`, `pharmacies_in_stock`, `oos_share_of_eligible`,
`cluster_band`.

Matching: `match_confidence` (0–1), `match_confidence_band`
(`high`/`medium`/`low`), `match_price_cv`, `match_flags`, `match_algo_version`.

Classification: `product_type`, `is_clinical`, `class_confidence`,
`class_basis`, `class_contested`, `class_gap_reason`, `classifier_version`.

Reference data: `di_brand_key`, `di_ai_key`, `active_ingredient`, `indications`,
`therapeutic_category`, `drugindex_fingerprint`.

Review + price: `review_state`, `review_reason`, `price_min`, `price_median`,
`price_max`.

**Enums.**
`product_type` ∈ `medicine` · `supplement` · `device` · `cosmetic` ·
`personal_care` · `sexual_wellness` · `food` · `unclassified`
`cluster_band` ∈ `none` · `isolated` (1) · `local` (2) · `cluster` (3–4) ·
`systemic` (5–9) · `national` (10–14) · `total` (15+)
`class_gap_reason` ∈ `null` (clean) · `contested` · `ambiguous` · `di_miss`
`review_state` ∈ `auto` · `needs_review`

`therapeutic_category` is one of DrugIndex's 21 top-level categories, reached
through the matched active ingredient. **It is populated but not universal:**
21.1% of all products and 58.5% of clinical products carry one, spanning 19
distinct classes. It is null where the product matched no ingredient, or where
the ingredient is not filed under a category upstream. Treat it as a filter
that narrows, never as a partition — filtering on a class silently drops every
unclassed product, so a class breakdown must show the null bucket.

### `observation_scored` — every listing, latest snapshot

All `observation` columns plus `publishes_oos`, `pharmacy_quarantined` and
**`stock_evidence`**.

`stock_state` is what the shop literally said (`in_stock` / `out_of_stock` /
`unknown`). `stock_evidence` is what it is worth as evidence — the same values
plus `not_published`, which replaces everything from a feed that does not
publish the bit. **Aggregate on `stock_evidence`.**

Useful columns: `pharmacy_id`, `product_key`, `raw_name`, `canonical_name`,
`category_raw`, `brand_raw`, `price_kes`, `product_url`, `image_url`, `sku`,
`match_confidence`.

`product_url` is the live product page and is safe to link — 3,610 malformed
Portal URLs are repaired on ingest (`product_url_repaired` flags them).

### `shortage_signal` — the table the dashboard leads with

Clinical products only, `pharmacies_oos >= 2`, confident match, not in review.
Ordered worst first. **36 rows today. Zero clinical products reach 3
pharmacies.** The brief's "23 systemic shortages" does not survive honest
matching plus a medicine filter — both products that reach 3 shops are a
supplement and a face mask.

### `review_queue` — human adjudication

`review_state = 'needs_review'`, worst first. `review_reason` distinguishes
`low match confidence` from `contested classification`.

### `drugindex_backlog` — what finishing the scrape would buy

Products where `class_gap_reason = 'di_miss'`: unclassified with no DrugIndex
hit and no usable shop category. **9,164 rows.** Ordered by how many pharmacies
list them, so the highest-value reference gaps come first. This is a useful
screen for Dennis, and a good progress metric — it should shrink each time the
reference scrape runs.

### `drugindex_coverage` — the caveat, as data

`fingerprint`, `available`, `missing_files`, `warnings`, `brands_rows`,
`ingredients_rows`, `latest_updated_at`, `distinct_scrape_days`,
`link_*` ratios, `drugindex_match_rate`, `products_with_drugindex_match`,
`products_awaiting_drugindex`, `catalogue_blocked_on_drugindex`.

Current: 25.1% of the catalogue matched, 21.0% blocked on reference data,
`link_ingredient_to_category` = 0.

These are **linkage ratios between records we hold**, never a percentage of
some assumed true total. Nothing can know how complete DrugIndex is from the
inside, and the UI should not imply otherwise. "25.1% of our catalogue is
matched to the drug register" is honest; "DrugIndex is 25% complete" is not.

### `current_run` — provenance

`run_id`, `snapshot_id`, `started_at`, `finished_at`, `duration_ms`,
`contract_version`, `match_algo_version`, `classifier_version`,
`drugindex_fingerprint`, `shops_expected`, `shops_ingested`, `shops_failed`,
`shops_absent`, `observations`, `products`, `warnings`, `snapshot_at_inferred`.

`snapshot_at_inferred` is true when **any** shop in the run had no readable
`<shop>.meta.json` and fell back to file mtime. It is deliberately pessimistic:
a snapshot whose clock is part guess is not a snapshot with a trustworthy
clock, and the UI badges it accordingly.

Nothing in the UI hardcodes a version string: the provenance line under the KPI
strip, the rail footer and the export filename all read this view, so they stay
correct when the algorithm or the snapshot changes.

### `pharmacy_scrape_time` — when each shop was actually scraped

`snapshot_id`, `pharmacy_id`, `scraped_at`, `scraped_at_latest`,
`scraped_at_inferred`.

Derived from `observation`, so it carries every snapshot, not just the latest.
`scraped_at` and `scraped_at_latest` are equal for a normal run; they differ
only if one shop's rows somehow disagree, which `verify.js` asserts against.
Use this rather than the headline date when showing per-shop freshness — the
shops in one snapshot are not scraped at the same moment.

### History

`observation_history`, `product_history`, `pharmacy_history` — all snapshots.

`pharmacy_trend` — per shop per snapshot with `listings_delta` and
`in_stock_rate_delta`.
`product_trend` — per product per snapshot with `oos_delta` and
`price_median_delta`.

Both return rows today with null deltas (one snapshot). **Safe to bind to now**
— they populate themselves when snapshot #2 lands, so nothing needs rewriting.

---

## Commands

```bash
npm run build       # full rebuild from raw JSON
npm run verify      # 75 assertions, non-zero exit on failure
npm run reclassify  # re-run classification only, after DrugIndex grows
npm run export:app  # project the views into the browser read model
npm run dev         # run the interface
npm run refresh     # build + verify + export
npm run ci          # strict build + verify + export + production bundle
```

`build` flags: `--source <dir>`, `--out <dir>`, `--snapshot <id>`, `--rebuild`
(discard history), `--strict` (fail if any shop fails to ingest).

**`reclassify` is the one to know about.** Matching does not depend on
DrugIndex, so when the reference scrape grows there is no reason to re-ingest
51,350 rows. `reclassify` re-scores classification in place, reports exactly
what moved, and rewrites `product.parquet`. It is a no-op when the DrugIndex
fingerprint is unchanged, so it is safe to run on a cron or after every scrape.

Measured on a reference set grown from 40% to 100%: **1,813 products newly
classified, backlog 10,949 → 9,164**, in about two seconds.

---

## Guarantees

- **Idempotent.** Re-running a snapshot replaces exactly that snapshot's rows.
- **Fault isolated.** A corrupt or reshaped shop file degrades the run to the
  remaining shops with a warning recorded in `pharmacy.ingest_error` and
  `current_run.warnings`. It does not abort the build. Use `--strict` in CI.
- **Validated input.** Column reordering or a changed row shape upstream is
  caught at ingest with a specific error, not silently absorbed.
- **Degrades without reference data.** With DrugIndex entirely absent the
  pipeline still produces a full dashboard from shop categories and name rules;
  medicine classification falls from 25.8% to 15.4% and says so.
- **Monotonic.** More reference data never classifies fewer products. This is
  asserted in `verify.js` — it regressed once, when a weak mid-name brand match
  suppressed a generic-name match and demoted four antibiotics.
- **Stable types.** Physical schemas are declared in `pipeline/schema.js`
  rather than inferred from JSON, so a column that is all-null one month and
  populated the next does not change type.

## Known limitations

| | |
|---|---|
| `snapshot_at` is inferred for the September snapshot | those files predate the `<shop>.meta.json` sidecar; re-scrape, or copy the sidecars over, and it becomes exact |
| `therapeutic_category` null on 78.9% of products | 22% of DrugIndex ingredients are unfiled upstream; the rest is products that matched no ingredient |
| Single snapshot | trend views are live but empty until a second scrape |
| 3 pharmacies absent | PharmaPlus, Faiz, MyDawa — network/WAF blocked |
| OneStop returned 25 rows | scrape is broken, feed quarantined |
| 22.5% unclassified | 21.0 pts of that is reference-data gap, 1.5 pts ambiguous |
