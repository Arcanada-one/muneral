# Task activity snapshot canonical codec

Status: pure source codec contract. This document and its implementation do not add an HTTP route, database reader, persisted snapshot, authorization capability, or KC consumer. A future source adapter must provide values in the explicit lossless input types defined by the codec.

## Canonical document

The codec builds `TaskActivitySnapshotCanonical/v1` with exactly these fields: `schema`, `snapshot_id`, `task_id`, `workspace_id`, `owner`, `captured_at`, `expires_at`, `consistency`, `order`, `page_size`, `total`, `task_at_snapshot`, and `rows`. Rows have contiguous one-based `position` values and contain an immutable activity value. Activity and task metadata use the snake_case names in the canonical definition. `total` is derived from supplied rows; `expires_at` is derived as exactly 900 seconds after `captured_at`.

Identifiers are lowercase hyphenated UUID strings. Actor types are `human` or `agent`; task status must be one of Muneral's existing seven statuses. Hashed timestamps use `YYYY-MM-DDTHH:mm:ss.ffffffZ`, valid Gregorian dates in years 0001 through 9999, with exactly six fractional digits. `captured_at` and activity timestamps must already be exact UTC text; JavaScript `Date` is not an accepted source type.

The canonical bytes are UTF-8 RFC 8785 JSON Canonicalization Scheme bytes with no BOM or trailing newline. Object keys use the JCS UTF-16 code-unit ordering, strings must contain only valid Unicode scalar sequences, and strings are not normalized. The digest is:

```text
"sha256:" + lowercase_hex(SHA256(ASCII("Muneral.TaskActivitySnapshotCanonical/v1") || 0x00 || canonical_bytes))
```

The digest detects content changes; it is not a signature or authorization token.

## Lossless payload profile

The adapter-neutral input is a tagged tree with node types `null`, `boolean`, `string`, `number`, `array`, and `object`. Number nodes carry their original valid finite JSON number token as text. Object nodes carry key/value entries so duplicate keys can be rejected before canonical bytes are produced. Output tags are recursively represented as arrays: `['null']`, `['boolean', value]`, `['string', text]`, `['number', decimal_token]`, `['array', children]`, and `['object', [[key, child], ...]]`. SQL NULL and JSON null both encode as `['null']`.

Decimal tokens are parsed without converting through JavaScript `Number`. The normalized token has a signed integer coefficient with no leading or trailing zero and a lowercase `e` followed by a canonical signed integer exponent. Mathematical zero is always `0e0`; a nonzero exponent of zero is written `0`. Invalid numeric syntax, duplicate keys, unsupported types, invalid Unicode, and noncanonical input refuse the complete codec operation.

## Bounds and page reconstruction

The pure codec enforces at most 10,000 rows, 16 MiB canonical document bytes, 64 KiB encoded activity bytes per row, 1 MiB canonical page bytes, and a 64 MiB aggregate canonical encoding for a complete page collection, matching the v4 consumer envelope. It validates the first page header and expected collection count before touching later page bodies, then validates pages sequentially and charges encoded rows before retaining them. Payload depth is at most 64, payload nodes at most 16,384 per row, and page sizes are from 1 through 500. It rejects unsorted activities; the caller must provide `created_at DESC, id DESC` source order. Empty history is represented by one page with `page=1`, `total_pages=1`, `has_more=false`, and no rows.

Page reconstruction checks the invariant metadata and digest across pages, sequential page numbers, page counts, exact row intervals and positions, unique activity IDs, and the recomputed canonical digest. These pure checks operate only on supplied values; they do not fetch, authorize, or persist anything.

## Prospective KC-compatible response profile

The codec's 1 MiB limit applies to the canonical encoded representation of each page. The v4 KC-compatible profile is stricter: each complete compact, uncompressed UTF-8 HTTP response body, including repeated metadata and rows, must be at most 900,000 bytes. That profile replaces the generic 1 MiB response ceiling and starts with `page_size=1`. Its proposed enumeration limits are 64 MiB across complete response bodies (including repeated metadata), 16 MiB canonical content, at most 10,000 pages, and an overall deadline of at most five minutes and strictly before snapshot expiry. These are prospective refusal limits, not throughput or fit evidence.

This pure codec does not measure a serialized HTTP response body, enforce an enumeration deadline, or establish that a KC consumer can complete within these limits. No KC reader, transport, adoption, or KC fit is implemented or claimed here.

## Required future adapter boundary

The current Prisma `ActivityLog.payload Json?` and `createdAt DateTime @db.Timestamptz()` types do not prove exact numeric-token or microsecond preservation. Existing Prisma `findMany` activity reads also do not provide a pre-transfer row/byte bound. A later adapter must supply exact decimal text and six-digit UTC timestamp text, and must establish source count, decompressed payload size, bounded transfer, and transaction consistency before materializing the values. The codec's in-memory byte checks do not prove those source-side bounds.

This codec establishes no route behavior, current ACL or revocation semantics, repeatable-read snapshot, PostgreSQL ordering, concurrency, quota accounting, expiry enforcement, cleanup, consumer fit, KC adoption, runtime behavior, or deployment result. Those remain `NOT_MEASURED` until separately implemented and verified.
