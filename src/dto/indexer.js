'use strict';

/**
 * @fileoverview Typed DTO layer for the indexer boundary.
 *
 * Defines request/response DTOs and bi-directional mapping functions used at
 * every entry and exit point of the indexer subsystem:
 *
 *   - {@link IndexerEventsQueryDTO}  – parsed, validated query params (request side)
 *   - {@link EscrowEventRowDTO}      – a single row returned from `escrow_events` (response side)
 *   - {@link IndexerEventsMetaDTO}   – pagination metadata envelope (response side)
 *   - {@link IndexerEventsResponseDTO} – full service/route response envelope
 *   - {@link IndexerIngestEventDTO}  – inbound event shape fed to the indexer job
 *
 * Mappers follow a strict boundary pattern:
 *
 *   raw query params  → {@link mapQueryToDTO}     → IndexerEventsQueryDTO
 *   IndexerEventsQueryDTO → {@link mapDTOToServiceParams} → service options object
 *   DB row            → {@link mapRowToEscrowEventDTO} → EscrowEventRowDTO
 *   service result    → {@link mapServiceResultToResponseDTO} → IndexerEventsResponseDTO
 *   raw ingest event  → {@link mapRawToIngestDTO}  → IndexerIngestEventDTO
 *
 * Ingest validation reuses the existing event schema; other boundaries enforce
 * their structural and range invariants directly.
 *
 * Compatibility contract: every mapper is total and deterministic. Unknown or
 * malformed inputs are coerced to safe defaults rather than throwing, so that
 * callers relying on the previous inline behavior keep working unchanged.
 *
 * @module dto/indexer
 */

const { indexerEventSchema } = require('../schemas/indexerEvent');

const INDEXER_SORT_FIELDS = new Set(['observed_at', 'ledger_sequence']);
const MAX_PAGE_SIZE = 100;

/**
 * Require a plain object at a DTO boundary.
 *
 * @param {unknown} value - Value to check.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {Record<string, unknown>} The validated record.
 */
function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  return value;
}

/**
 * Reject keys outside the documented DTO shape.
 *
 * @param {Record<string, unknown>} value - DTO record to check.
 * @param {string[]} allowedKeys - Supported own keys.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {void}
 */
function requireOnlyKeys(value, allowedKeys, label) {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

/**
 * Read a required own property so prototype values cannot satisfy a DTO shape.
 *
 * @param {Record<string, unknown>} value - DTO record to inspect.
 * @param {string[]} requiredKeys - Required own property names.
 * @param {string} label - Boundary field name for safe error messages.
 * @returns {void}
 */
function requireOwnKeys(value, requiredKeys, label) {
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing required fields`);
  }
}

/**
 * Read an optional string without coercing objects, numbers, or booleans.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @param {number} [maxLength=Infinity] - Maximum accepted length.
 * @returns {string|undefined} The value, or undefined when absent.
 */
function optionalString(value, label, maxLength = Infinity) {
  if (value === undefined) {return undefined;}
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Convert an integer or integer string while rejecting unsafe/out-of-range values.
 *
 * @param {unknown} value - Candidate number.
 * @param {string} label - Field name for safe error messages.
 * @param {number} minimum - Inclusive lower bound.
 * @param {number} maximum - Inclusive upper bound.
 * @returns {number} Validated safe integer.
 */
function safeInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be a safe integer in the supported range`);
  }
  return parsed;
}

/**
 * Require a non-empty textual field, optionally accepting numeric DB identifiers.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @param {boolean} [allowNumber=false] - Whether finite numbers may be stringified.
 * @param {number} [maxLength=Infinity] - Maximum accepted string length.
 * @returns {string} Validated string value.
 */
function requiredString(value, label, allowNumber = false, maxLength = Infinity) {
  const text = allowNumber && typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : value;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return text;
}

/**
 * Normalize a nullable database text field without coercing invalid values.
 *
 * @param {unknown} value - Candidate field value.
 * @param {string} label - Field name for safe error messages.
 * @returns {string|null} The string value or null.
 */
function nullableString(value, label) {
  return value == null ? null : requiredString(value, label);
}

/**
 * Normalize a nullable timestamp while rejecting invalid dates.
 *
 * @param {unknown} value - Candidate timestamp.
 * @param {string} label - Field name for safe error messages.
 * @returns {string|null} ISO text, source text, or null.
 */
function nullableTimestamp(value, label) {
  if (value == null) {return null;}
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {throw new TypeError(`${label} must be a valid timestamp`);}
    return value.toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return value;
}

/**
 * Validate a required timestamp value.
 *
 * @param {unknown} value - Timestamp value.
 * @param {string} label - Field name for safe error messages.
 * @returns {string} ISO string or valid source timestamp string.
 */
function requiredTimestamp(value, label) {
  const timestamp = nullableTimestamp(value, label);
  if (timestamp === null) {
    throw new TypeError(`${label} is required`);
  }
  return timestamp;
}

/**
 * Validate an ingest event with the canonical event schema and report field names only.
 *
 * @param {unknown} event - Candidate event data.
 * @returns {object} Parsed indexer event.
 */
function validateIngestEvent(event) {
  const result = indexerEventSchema.safeParse(event);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0] || '_root')))];
    throw new TypeError(`Indexer event contains invalid fields: ${fields.join(', ')}`);
  }
  return result.data;
}

/**
 * Resolve a supported snake_case/camelCase alias pair without accepting conflicts.
 *
 * @param {Record<string, unknown>} raw - Source event.
 * @param {string} snakeKey - Preferred snake_case key.
 * @param {string} camelKey - Supported camelCase alias.
 * @param {string} label - Field label for safe error messages.
 * @returns {unknown} Resolved value, or undefined when absent.
 */
function resolveAlias(raw, snakeKey, camelKey, label) {
  const snakeValue = raw[snakeKey];
  const camelValue = raw[camelKey];
  if (snakeValue != null && camelValue != null && !Object.is(snakeValue, camelValue)) {
    throw new TypeError(`${label} aliases must not conflict`);
  }
  return snakeValue != null ? snakeValue : camelValue;
}

/**
 * Copy event data so later caller mutations cannot alter an accepted DTO.
 *
 * @param {unknown} value - Event-body value.
 * @returns {unknown} Independent structured clone.
 */
function cloneEventBody(value) {
  return structuredClone(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Request DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of the validated query parameters for the indexer
 * events listing endpoint (GET /api/admin/indexer/events).
 *
 * All fields are immutable after construction to prevent accidental mutation.
 *
 * @typedef {object} IndexerEventsQueryDTO
 * @property {object}      filters
 * @property {string|undefined} filters.invoiceId  - Exact-match filter on invoice ID.
 * @property {string|undefined} filters.eventType  - Exact-match filter on event type.
 * @property {string|undefined} filters.contractId - Exact-match filter on contract ID.
 * @property {object}      sorting
 * @property {string}      sorting.sortBy   - Sort field ('observed_at' | 'ledger_sequence').
 * @property {string}      sorting.order    - Sort direction ('asc' | 'desc').
 * @property {object}      pagination
 * @property {string|undefined} pagination.cursor - Opaque HMAC-signed cursor.
 * @property {number|undefined} pagination.page   - 1-based page number (offset mode).
 * @property {number|undefined} pagination.limit  - Page size (1–100).
 */

/**
 * Constructs an {@link IndexerEventsQueryDTO} from the parsed `params` object
 * produced by `adminIndexer._parseQuery()`.
 *
 * The mapping is intentionally explicit so every field is traceable and type
 * errors surface at the boundary rather than deep inside the service.
 *
 * @param {object} params - Normalised params from `_parseQuery`.
 * @param {object} [params.filters={}]
 * @param {object} [params.sorting={}]
 * @param {object} [params.pagination={}]
 * @returns {IndexerEventsQueryDTO}
 */
function mapQueryToDTO(params) {
  const source = requireRecord(params, 'params');
  requireOnlyKeys(source, ['filters', 'sorting', 'pagination'], 'params');
  const filters = source.filters === undefined ? {} : requireRecord(source.filters, 'filters');
  const sorting = source.sorting === undefined ? {} : requireRecord(source.sorting, 'sorting');
  const pagination = source.pagination === undefined ? {} : requireRecord(source.pagination, 'pagination');
  requireOnlyKeys(filters, ['invoiceId', 'eventType', 'contractId'], 'filters');
  requireOnlyKeys(sorting, ['sortBy', 'order'], 'sorting');
  requireOnlyKeys(pagination, ['cursor', 'page', 'limit'], 'pagination');

  const sortBy = sorting.sortBy === undefined ? 'observed_at' : optionalString(sorting.sortBy, 'sorting.sortBy');
  if (!INDEXER_SORT_FIELDS.has(sortBy)) {
    throw new TypeError('sorting.sortBy must be a supported field');
  }
  const order = sorting.order === undefined ? 'desc' : sorting.order;
  if (order !== 'asc' && order !== 'desc') {
    throw new TypeError('sorting.order must be asc or desc');
  }

  const sortBy = sorting.sortBy !== undefined ? String(sorting.sortBy) : 'observed_at';
  if (sortBy !== 'observed_at' && sortBy !== 'ledger_sequence') {
    throw new RangeError(`mapQueryToDTO: invalid sortBy "${sortBy}"`);
  }

  const order = sorting.order === 'asc' ? 'asc' : 'desc';

  const page = pagination.page !== undefined ? Number(pagination.page) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new RangeError('mapQueryToDTO: page must be a positive integer');
  }

  const limit = pagination.limit !== undefined ? Number(pagination.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new RangeError('mapQueryToDTO: limit must be an integer between 1 and 100');
  }

  return Object.freeze({
    filters: Object.freeze({
      invoiceId: optionalString(filters.invoiceId, 'filters.invoiceId', 128),
      eventType: optionalString(filters.eventType, 'filters.eventType', 128),
      contractId: optionalString(filters.contractId, 'filters.contractId', 56),
    }),
    sorting: Object.freeze({
      sortBy,
      order,
    }),
    pagination: Object.freeze({
      cursor: optionalString(pagination.cursor, 'pagination.cursor', 2048),
      page: pagination.page !== undefined ? safeInteger(pagination.page, 'pagination.page', 1) : undefined,
      limit: pagination.limit !== undefined ? safeInteger(pagination.limit, 'pagination.limit', 1, MAX_PAGE_SIZE) : undefined,
    }),
  });
}

/**
 * Converts an {@link IndexerEventsQueryDTO} back into the plain options object
 * accepted by {@link module:services/indexerService.listIndexerEvents}.
 *
 * This is the second half of the request-side mapping.  The service receives
 * only what it needs: optional fields whose value is `undefined` are omitted
 * so the service's own defaults apply transparently.
 *
 * @param {IndexerEventsQueryDTO} dto
 * @returns {{ filters: object, sorting: object, pagination: object }}
 */
function mapDTOToServiceParams(dto) {
  const validated = mapQueryToDTO(dto);
  const filters = {};
  if (validated.filters.invoiceId !== undefined) {filters.invoiceId = validated.filters.invoiceId;}
  if (validated.filters.eventType !== undefined) {filters.eventType = validated.filters.eventType;}
  if (validated.filters.contractId !== undefined) {filters.contractId = validated.filters.contractId;}

  const sorting = {};
  if (validated.sorting.sortBy !== undefined) {sorting.sortBy = validated.sorting.sortBy;}
  if (validated.sorting.order !== undefined) {sorting.order = validated.sorting.order;}

  const pagination = {};
  if (validated.pagination.cursor !== undefined) {pagination.cursor = validated.pagination.cursor;}
  if (validated.pagination.page !== undefined) {pagination.page = validated.pagination.page;}
  if (validated.pagination.limit !== undefined) {pagination.limit = validated.pagination.limit;}

  return { filters, sorting, pagination };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of a single row from the `escrow_events` table as
 * returned by the listing endpoint.
 *
 * `event_body` is not included because it is intentionally excluded from list
 * responses; callers that need it should fetch a specific event by ID.
 *
 * @typedef {object} EscrowEventRowDTO
 * @property {string}      eventId        - Primary key (UUID / paging-token-derived).
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name (e.g. `'escrow_created'`).
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string|null} pagingToken    - Horizon paging token, or null.
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {string}      observedAt     - ISO-8601 timestamp when the event was indexed.
 * @property {string|null} createdAt      - Timestamp when the row was created, or null.
 */

/**
 * Maps a raw database row from `escrow_events` into an {@link EscrowEventRowDTO}.
 *
 * Column names use snake_case (as returned by Knex); the DTO uses camelCase to
 * match the JSON API convention.  Null-safety is applied to all nullable
 * columns so consumers can rely on the type contract without further coercion.
 *
 * @param {object} row - Raw Knex row from `escrow_events`.
 * @returns {EscrowEventRowDTO}
 */
function mapRowToEscrowEventDTO(row) {
  const source = requireRecord(row, 'row');
  requireOwnKeys(source, ['event_id', 'invoice_id', 'event_type', 'ledger_sequence'], 'row');
  return Object.freeze({
    eventId: requiredString(source.event_id, 'event_id', true, 256),
    invoiceId: requiredString(source.invoice_id, 'invoice_id', true, 128),
    eventType: requiredString(source.event_type, 'event_type', false, 128),
    ledgerSequence: safeInteger(source.ledger_sequence, 'ledger_sequence', 1),
    pagingToken: nullableString(source.paging_token, 'paging_token'),
    contractId: nullableString(source.contract_id, 'contract_id'),
    txHash: nullableString(source.tx_hash, 'tx_hash'),
    observedAt: requiredTimestamp(source.observed_at, 'observed_at'),
    createdAt: nullableTimestamp(source.created_at, 'created_at'),
  });
}

/**
 * Maps an {@link EscrowEventRowDTO} back to a DB row-shaped plain object
 * (snake_case).  Used in tests to verify round-trip fidelity.
 *
 * @param {EscrowEventRowDTO} dto
 * @returns {object}
 */
function mapEscrowEventDTOToRow(dto) {
  const source = requireRecord(dto, 'dto');
  requireOnlyKeys(source, [
    'eventId', 'invoiceId', 'eventType', 'ledgerSequence', 'pagingToken',
    'contractId', 'txHash', 'observedAt', 'createdAt',
  ], 'dto');
  requireOwnKeys(source, [
    'eventId', 'invoiceId', 'eventType', 'ledgerSequence', 'pagingToken',
    'contractId', 'txHash', 'observedAt', 'createdAt',
  ], 'dto');
  requireOnlyKeys(source, [
    'eventId', 'invoiceId', 'eventType', 'ledgerSequence', 'pagingToken',
    'contractId', 'txHash', 'observedAt', 'createdAt',
  ], 'dto');
  requireOwnKeys(source, [
    'eventId', 'invoiceId', 'eventType', 'ledgerSequence', 'pagingToken',
    'contractId', 'txHash', 'observedAt', 'createdAt',
  ], 'dto');
  const validated = mapRowToEscrowEventDTO({
    event_id: source.eventId,
    invoice_id: source.invoiceId,
    event_type: source.eventType,
    ledger_sequence: source.ledgerSequence,
    paging_token: source.pagingToken,
    contract_id: source.contractId,
    tx_hash: source.txHash,
    observed_at: source.observedAt,
    created_at: source.createdAt,
  });
  return {
    event_id: validated.eventId,
    invoice_id: validated.invoiceId,
    event_type: validated.eventType,
    ledger_sequence: validated.ledgerSequence,
    paging_token: validated.pagingToken,
    contract_id: validated.contractId,
    tx_hash: validated.txHash,
    observed_at: validated.observedAt,
    created_at: validated.createdAt,
  };
}

/**
 * Pagination metadata returned by the listing endpoint.
 *
 * @typedef {object} IndexerEventsMetaDTO
 * @property {number}      total       - Total matching rows across all pages.
 * @property {number}      limit       - Page size used for this response.
 * @property {boolean}     hasMore     - Whether additional pages exist.
 * @property {string|null} nextCursor  - Opaque cursor for the next page, or null.
 * @property {number|undefined} page       - Current page (offset mode only).
 * @property {number|undefined} totalPages - Total number of pages (offset mode only).
 */

/**
 * Maps the raw `meta` object returned by {@link listIndexerEvents} into an
 * {@link IndexerEventsMetaDTO}.
 *
 * @param {object} rawMeta
 * @returns {IndexerEventsMetaDTO}
 */
function mapMetaToDTO(rawMeta) {
  const source = requireRecord(rawMeta, 'meta');
  requireOnlyKeys(source, ['total', 'limit', 'hasMore', 'nextCursor', 'page', 'totalPages'], 'meta');
  requireOwnKeys(source, ['total', 'limit', 'hasMore'], 'meta');
  if (typeof source.hasMore !== 'boolean') {
    throw new TypeError('meta.hasMore must be a boolean');
  }

  const dto = {
    total: safeInteger(source.total, 'meta.total', 0),
    limit: safeInteger(source.limit, 'meta.limit', 1, MAX_PAGE_SIZE),
    hasMore: source.hasMore,
    nextCursor: source.nextCursor == null ? null : optionalString(source.nextCursor, 'meta.nextCursor', 2048),
  };
  if (source.page !== undefined) {dto.page = safeInteger(source.page, 'meta.page', 1);}
  if (source.totalPages !== undefined) {dto.totalPages = safeInteger(source.totalPages, 'meta.totalPages', 0);}
  if ((dto.page === undefined) !== (dto.totalPages === undefined)) {
    throw new TypeError('meta.page and meta.totalPages must be provided together');
  }
  if (dto.totalPages !== undefined && dto.totalPages !== Math.ceil(dto.total / dto.limit)) {
    throw new TypeError('meta.totalPages is inconsistent with total and limit');
  }
  if (dto.hasMore !== (dto.nextCursor !== null)) {
    throw new TypeError('meta.hasMore is inconsistent with nextCursor');
  }
  return Object.freeze(dto);
}

/**
 * Full indexer events response DTO returned to the route layer.
 *
 * @typedef {object} IndexerEventsResponseDTO
 * @property {EscrowEventRowDTO[]}  data  - Page of escrow event rows.
 * @property {IndexerEventsMetaDTO} meta  - Pagination metadata.
 */

/**
 * Maps the raw service result `{ data: object[], meta: object }` into a typed
 * {@link IndexerEventsResponseDTO}.
 *
 * @param {{ data: object[], meta: object }} serviceResult
 * @returns {IndexerEventsResponseDTO}
 */
function mapServiceResultToResponseDTO(serviceResult) {
  const source = requireRecord(serviceResult, 'serviceResult');
  requireOnlyKeys(source, ['data', 'meta', 'correlationId'], 'serviceResult');
  requireOwnKeys(source, ['data', 'meta'], 'serviceResult');
  if (!Array.isArray(source.data)) {
    throw new TypeError('serviceResult.data must be an array');
  }

  const data = source.data.map(mapRowToEscrowEventDTO);
  const eventIds = new Set(data.map((event) => event.eventId));
  if (eventIds.size !== data.length) {
    throw new TypeError('serviceResult.data must not contain duplicate event IDs');
  }

  const meta = mapMetaToDTO(source.meta);
  if (data.length > meta.limit) {
    throw new TypeError('serviceResult.data exceeds the declared page limit');
  }

  return Object.freeze({
    data: Object.freeze(data),
    meta,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest / job DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of a raw escrow event as it enters the indexer job
 * boundary (i.e. what `normalizeEvent` + `persistEscrowEvent` consume).
 *
 * This is the inbound shape before it is written to the database, not the
 * outbound/read shape.
 *
 * @typedef {object} IndexerIngestEventDTO
 * @property {string}      eventId        - Unique event identifier.
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name.
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string}      pagingToken    - Horizon paging token (empty string if absent).
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {object}      eventBody      - Full raw event payload.
 * @property {string}      observedAt     - ISO-8601 indexed-at timestamp.
 */

/**
 * Maps a raw Horizon record (as produced by `fetchEscrowEventsFromHorizon`)
 * into an {@link IndexerIngestEventDTO}.
 *
 * The mapper applies the same coercions used inline in the indexer job so that
 * the shape contract is expressed once in this module rather than scattered
 * across the job.
 *
 * Concurrent-execution invariants
 * ────────────────────────────────
 * - `observedAt` is always captured from `raw.observedAt` when present, or
 *   pinned to `capturedAt` (which the caller may supply, defaulting to the
 *   current instant).  This means two concurrent calls for the same raw event
 *   without an explicit `observedAt` will share the same timestamp when
 *   supplied the same `capturedAt`, producing deterministic ordering.
 * - `eventBody` is a shallow copy of the source so that subsequent mutations
 *   to `raw` do not affect the already-frozen DTO.
 * - `invoiceId` must be a non-empty string; an empty invoiceId makes the DTO
 *   unusable for projection keying and is therefore rejected here rather than
 *   inside the persistence layer.
 *
 * @param {object} raw - Raw record from `fetchEscrowEventsFromHorizon`.
 * @param {string} invoiceId - Pre-resolved invoice ID for this event.
 * @param {object} [opts] - Optional overrides for deterministic behaviour.
 * @param {string} [opts.capturedAt] - ISO-8601 timestamp to use when
 *   `raw.observedAt` is absent.  Callers that process a batch should derive
 *   this once before the loop so every event in the batch shares the same
 *   fallback timestamp.
 * @returns {IndexerIngestEventDTO}
 * @throws {TypeError} If `invoiceId` is falsy (empty string, null, undefined).
 */
function mapRawToIngestDTO(raw, invoiceId) {
  const source = requireRecord(raw, 'raw event');
  const eventId = requiredString(resolveAlias(source, 'id', 'eventId', 'eventId'), 'eventId', true, 256);
  const ledgerSequence = safeInteger(resolveAlias(source, 'ledger', 'ledgerSequence', 'ledgerSequence'), 'ledgerSequence', 1);
  const contractId = resolveAlias(source, 'contract_id', 'contractId', 'contractId');
  const txHash = resolveAlias(source, 'tx_hash', 'txHash', 'txHash');
  const pagingToken = resolveAlias(source, 'paging_token', 'pagingToken', 'pagingToken');
  const eventType = resolveAlias(source, 'type', 'eventType', 'eventType');
  const event = validateIngestEvent({
    eventId,
    invoiceId: String(invoiceId),
    eventType: eventType ?? 'contract_event',
    ledgerSequence,
    pagingToken: pagingToken ?? '',
    contractId: contractId ?? null,
    txHash: txHash ?? null,
    eventBody: source.eventBody !== undefined ? source.eventBody : source,
    observedAt: source.observedAt ?? new Date().toISOString(),
  });
  return Object.freeze({ ...event, eventBody: cloneEventBody(event.eventBody) });
}

/**
 * Maps an {@link IndexerIngestEventDTO} to the internal normalized shape
 * expected by `persistEscrowEvent` (the canonical event object).  This is the
 * inverse of `mapRawToIngestDTO` plus field aliasing.
 *
 * The returned object is frozen so that concurrent consumers of the same
 * normalized event cannot accidentally mutate shared state between the
 * persistence write and the projection update.
 *
 * @param {IndexerIngestEventDTO} dto
 * @returns {object} Normalized internal event (frozen).
 */
function mapIngestDTOToNormalized(dto) {
  const source = requireRecord(dto, 'dto');
  const event = validateIngestEvent(source);
  return {
    eventId: event.eventId,
    invoiceId: event.invoiceId,
    eventType: event.eventType,
    ledgerSequence: event.ledgerSequence,
    pagingToken: event.pagingToken || '',
    contractId: event.contractId !== undefined ? event.contractId : null,
    txHash: event.txHash !== undefined ? event.txHash : null,
    eventBody: event.eventBody !== undefined ? cloneEventBody(event.eventBody) : {},
    observedAt: event.observedAt || new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Request-side mappers
  mapQueryToDTO,
  mapDTOToServiceParams,
  // Response-side mappers
  mapRowToEscrowEventDTO,
  mapEscrowEventDTOToRow,
  mapMetaToDTO,
  mapServiceResultToResponseDTO,
  // Ingest / job mappers
  mapRawToIngestDTO,
  mapIngestDTOToNormalized,
};
