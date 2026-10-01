'use strict';

const formatProblemDetails = require('../utils/problemDetails');
const { getProblemType, getStandardTitle } = require('../utils/problemDetails');

/**
 * @fileoverview RFC 7807-compliant application error class.
 *
 * ## Design invariants
 *
 * 1. Construction is always **deterministic**: every field has a defined
 *    default, invalid inputs are coerced to safe values, and no call ever
 *    throws due to missing or malformed params.
 * 2. `status` is always a **safe integer in [100, 599]**; out-of-range values
 *    are clamped to 500 so `res.status()` never receives a bogus value.
 * 3. `title` and `this.message` are always **non-empty strings** — callers
 *    never see the literal "undefined" message that `super(undefined)` would
 *    produce.
 * 4. `type` is always a **non-empty string**; when omitted it is derived from
 *    `status` via the canonical `getProblemType` helper so the wire type is
 *    meaningful rather than the opaque "about:blank" default.
 * 5. `retryable` is always a **boolean** (never undefined/null on the
 *    instance), preventing accidental truthy/falsy bugs in callers.
 * 6. `retryHint` is always a **string** (never undefined), keeping the wire
 *    format stable.
 * 7. `fieldErrors` is always **undefined or a plain array**; it is included
 *    in `toJSON()` / `toHTTPResponse()` when present so the field-level
 *    validation surface is reachable without additional duck-typing.
 * 8. `context` is **never serialized** to JSON or included in HTTP responses;
 *    it exists solely for internal tracing and is explicitly excluded from
 *    `toJSON()`.
 * 9. The static `AppError.is(value)` type guard replaces ad-hoc
 *    `instanceof || .name === "AppError"` checks across the codebase.
 * 10. Static factory helpers (`notFound`, `forbidden`, `badRequest`,
 *     `conflict`, `unprocessable`, `tooManyRequests`, `serviceUnavailable`,
 *     `internal`) provide a single, consistent construction path for each
 *     common HTTP status.
 *
 * @module errors/AppError
 */

/** Minimum valid HTTP status code. */
const HTTP_STATUS_MIN = 100;
/** Maximum valid HTTP status code. */
const HTTP_STATUS_MAX = 599;
/** Fallback status when an invalid value is supplied. */
const HTTP_STATUS_FALLBACK = 500;

/**
 * Coerce a raw status value to a safe integer.
 *
 * @param {unknown} raw - Raw status value from params.
 * @returns {number} A valid HTTP status code in [100, 599].
 */
function coerceStatus(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return HTTP_STATUS_FALLBACK;
  }
  if (n < HTTP_STATUS_MIN || n > HTTP_STATUS_MAX) {
    return HTTP_STATUS_FALLBACK;
  }
  return n;
}

/**
 * Coerce a raw boolean-like value to a strict boolean.
 *
 * @param {unknown} raw - Raw value.
 * @param {boolean} defaultValue - Value returned when raw is not boolean-ish.
 * @returns {boolean}
 */
function coerceBool(raw, defaultValue) {
  if (raw === true || raw === false) return raw;
  return defaultValue;
}

/**
 * Coerce a raw string value to a trimmed, non-empty string or a fallback.
 *
 * @param {unknown} raw - Raw value.
 * @param {string} fallback - Returned when raw is not a usable string.
 * @returns {string}
 */
function coerceString(raw, fallback) {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return fallback;
}

/**
 * Custom Error class for RFC 7807-compliant problem responses.
 *
 * @extends {Error}
 *
 * @example
 * // Inline construction
 * throw new AppError({ status: 404, detail: 'Invoice not found.' });
 *
 * @example
 * // Via factory helper
 * throw AppError.notFound('Invoice not found.', { code: 'INVOICE_NOT_FOUND' });
 */
class AppError extends Error {
  /**
   * Validates HTTP status code is within valid range.
   *
   * @param {unknown} status - Status code to validate.
   * @throws {TypeError} If status is not a number or is out of valid range.
   * @static
   */
  static _validateStatus(status) {
    if (status !== undefined && status !== null) {
      if (typeof status !== 'number') {
        throw new TypeError(`AppError status must be a number, received: ${typeof status}`);
      }
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new RangeError(`AppError status must be an integer between 100 and 599, received: ${status}`);
      }
    }
  }

  /**
   * Validates type is a string when provided.
   *
   * @param {unknown} type - Type URI to validate.
   * @throws {TypeError} If type is not a string when provided.
   * @static
   */
  static _validateType(type) {
    if (type !== undefined && type !== null && typeof type !== 'string') {
      throw new TypeError(`AppError type must be a string, received: ${typeof type}`);
    }
  }

  /**
   * Validates retryable/retryHint consistency.
   *
   * @param {unknown} retryable - Retryable flag.
   * @param {unknown} retryHint - Retry hint.
   * @static
   */
  static _validateRetryConsistency(retryable, retryHint) {
    if (retryable === true && !retryHint) {
      // Log warning but don't throw - this is a soft invariant
      console.warn('[AppError] retryable=true without retryHint is discouraged');
    }
  }

  /**
   * Creates a new AppError instance.
   *
   * All fields have safe defaults; passing `null`, `undefined`, or a partial
   * object will never throw.
   *
   * @param {object|null|undefined} params
   * @param {string}  [params.type]       - RFC 7807 problem type URI.  Derived
   *   from `status` when omitted.
   * @param {string}  [params.title]      - Short human-readable summary.
   *   Derived from `status` when omitted.
   * @param {number}  [params.status=500] - HTTP status code.  Values outside
   *   [100, 599] are clamped to 500.
   * @param {string}  [params.detail]     - Human-readable occurrence detail.
   * @param {string}  [params.instance]   - URI identifying this occurrence.
   * @param {string}  [params.code]       - Machine-readable error code.
   * @param {boolean} [params.retryable=false] - Whether the caller may retry.
   * @param {string}  [params.retryHint='']    - Safe retry guidance.
   * @param {Array}   [params.fieldErrors]     - Field-level validation errors.
   * @param {unknown} [params.context]         - Internal tracing context (never
   *   serialized to JSON or HTTP responses).
   */
  constructor(params) {
    // Guard: treat null/undefined params as an empty object so every path
    // below has a defined object to work with.
    const safeParams = (params !== null && typeof params === 'object') ? params : {};

    // --- 1. Coerce / default all scalar fields deterministically -----------

    const status = coerceStatus(safeParams.status);

    // Derive title: explicit param → standard title from status → generic
    const title = coerceString(
      safeParams.title,
      getStandardTitle(status),
    );

    // Derive type: explicit param → status-based URI (never "about:blank" for
    // known statuses because that provides no actionable information)
    const type = coerceString(
      safeParams.type,
      getProblemType(status),
    );

    const detail = typeof safeParams.detail === 'string'
      ? safeParams.detail
      : undefined;

    const instance = typeof safeParams.instance === 'string'
      ? safeParams.instance
      : undefined;

    const code = typeof safeParams.code === 'string' && safeParams.code.trim()
      ? safeParams.code.trim()
      : undefined;

    // retryable: always a boolean, defaulting to false for non-transient codes
    const retryable = coerceBool(safeParams.retryable, false);

    // retryHint: always a string (may be empty), never undefined
    const retryHint = typeof safeParams.retryHint === 'string'
      ? safeParams.retryHint
      : '';

    // fieldErrors: only if it is an actual array; never coerced from other types
    const fieldErrors = Array.isArray(safeParams.fieldErrors)
      ? safeParams.fieldErrors
      : undefined;

    // context: internal only, never serialized
    const context = Object.prototype.hasOwnProperty.call(safeParams, 'context')
      ? safeParams.context
      : null;

    // --- 2. Initialize Error base -------------------------------------------
    // Use `title` so `error.message` is always a meaningful, non-empty string
    // rather than the literal "undefined" that `super(undefined)` would produce.
    super(title);
    this.name = 'AppError';

    // --- 3. Assign instance fields ------------------------------------------
    this.type = type;
    this.title = title;
    this.status = status;

    if (detail !== undefined) {
      this.detail = detail;
    }
    if (instance !== undefined) {
      this.instance = instance;
    }
    if (code !== undefined) {
      this.code = code;
    }

    // Always assign retryable and retryHint as concrete values so callers
    // never need to null-check them.
    this.retryable = retryable;
    this.retryHint = retryHint;

    if (fieldErrors !== undefined) {
      this.fieldErrors = fieldErrors;
    }

    // context is intentionally last and excluded from toJSON / toHTTPResponse
    this.context = context;

    // Capture stack trace, omitting this constructor frame.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // --- 4. Sync with canonical problem-details builder ---------------------
    // We call formatProblemDetails after field assignment so that the builder
    // can still apply any additional defaulting logic (e.g. stack omission in
    // production).  Any field already set above is passed explicitly so the
    // builder never overrides our coerced values.
    formatProblemDetails({
      type,
      title,
      status,
      detail,
      instance,
      code,
      retryable,
      retryHint,
      stack: undefined, // never pass stack into formatProblemDetails
    });
  }

  // ---------------------------------------------------------------------------
  // Serialization helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a plain RFC 7807 problem-details object suitable for JSON
   * serialization.  `context` is intentionally excluded to prevent internal
   * tracing state from leaking into logs or HTTP responses.
   *
   * @returns {object}
   */
  toJSON() {
    const obj = {
      type: this.type,
      title: this.title,
      status: this.status,
    };
    if (this.detail !== undefined) obj.detail = this.detail;
    if (this.instance !== undefined) obj.instance = this.instance;
    if (this.code !== undefined) obj.code = this.code;
    obj.retryable = this.retryable;
    if (this.retryHint) obj.retry_hint = this.retryHint;
    if (this.fieldErrors !== undefined) obj.field_errors = this.fieldErrors;
    return obj;
  }

  /**
   * Returns the shape expected by the centralized error handler and
   * `mapError`.  Suitable for direct use in `res.json()`.
   *
   * @param {string} [correlationId] - Optional request correlation ID.
   * @returns {object}
   */
  toHTTPResponse(correlationId) {
    const body = {
      code: this.code || _httpStatusToCode(this.status),
      message: this.detail || this.title,
      retryable: this.retryable,
      retry_hint: this.retryHint,
    };
    if (correlationId !== undefined) {
      body.correlation_id = String(correlationId);
    }
    if (this.fieldErrors !== undefined) {
      body.field_errors = this.fieldErrors;
    }
    return { error: body };
  }

  // ---------------------------------------------------------------------------
  // Static type guard
  // ---------------------------------------------------------------------------

  /**
   * Type guard that replaces the fragile `instanceof AppError ||
   * error.name === "AppError"` pattern used throughout the codebase.
   *
   * Accepts deserialized errors from across serialization boundaries (e.g.
   * worker message passing) that share the same shape but may not share the
   * same prototype chain.
   *
   * @param {unknown} value - Value to test.
   * @returns {boolean}
   */
  static is(value) {
    if (!value || typeof value !== 'object') return false;
    return value instanceof AppError || value.name === 'AppError';
  }

  // ---------------------------------------------------------------------------
  // Static factory helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a 400 Bad Request error.
   *
   * @param {string} [detail] - Human-readable detail.
   * @param {object} [extras] - Additional AppError params.
   * @returns {AppError}
   */
  static badRequest(detail, extras = {}) {
    return new AppError({ status: 400, detail, ...extras });
  }

  /**
   * Create a 401 Unauthorized error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static unauthorized(detail, extras = {}) {
    return new AppError({ status: 401, detail, ...extras });
  }

  /**
   * Create a 403 Forbidden error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static forbidden(detail, extras = {}) {
    return new AppError({ status: 403, detail, ...extras });
  }

  /**
   * Create a 404 Not Found error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static notFound(detail, extras = {}) {
    return new AppError({ status: 404, detail, ...extras });
  }

  /**
   * Create a 409 Conflict error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static conflict(detail, extras = {}) {
    return new AppError({ status: 409, detail, ...extras });
  }

  /**
   * Create a 422 Unprocessable Entity error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static unprocessable(detail, extras = {}) {
    return new AppError({ status: 422, detail, ...extras });
  }

  /**
   * Create a 429 Too Many Requests error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static tooManyRequests(detail, extras = {}) {
    return new AppError({
      status: 429,
      detail,
      retryable: true,
      retryHint: 'Wait for the rate limit window to reset before retrying.',
      ...extras,
    });
  }

  /**
   * Create a 500 Internal Server Error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static internal(detail, extras = {}) {
    return new AppError({ status: 500, detail, ...extras });
  }

  /**
   * Create a 503 Service Unavailable error.
   *
   * @param {string} [detail]
   * @param {object} [extras]
   * @returns {AppError}
   */
  static serviceUnavailable(detail, extras = {}) {
    return new AppError({
      status: 503,
      detail,
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
      ...extras,
    });
  }

  /**
   * Wrap an unknown thrown value in an AppError, preserving the original as
   * `context` for internal diagnostics.
   *
   * If `cause` is already an AppError it is returned unchanged.
   *
   * @param {unknown} cause - The original thrown value.
   * @param {object}  [extras] - Additional AppError params to apply.
   * @returns {AppError}
   */
  static wrap(cause, extras = {}) {
    if (AppError.is(cause)) return /** @type {AppError} */ (cause);
    return new AppError({
      status: 500,
      detail: 'An internal error occurred.',
      ...extras,
      context: cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Well-known error code constants
// ---------------------------------------------------------------------------

/**
 * A job lease fencing token was rejected.
 *
 * Returned when a worker attempts a write/complete operation after its lease
 * has expired or been reassigned.  Non-retryable by default.
 *
 * @type {string}
 */
AppError.FENCING_TOKEN_REJECTED = 'FENCING_TOKEN_REJECTED';

// ---------------------------------------------------------------------------
// Module-private helpers (exported for mapError / errorHandler reuse)
// ---------------------------------------------------------------------------

/**
 * Derive a stable error code from an HTTP status code.
 *
 * @param {number} status
 * @returns {string}
 * @private
 */
function _httpStatusToCode(status) {
  const MAP = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_SERVER_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
    504: 'GATEWAY_TIMEOUT',
  };
  return MAP[status] || `HTTP_${status}`;
}

module.exports = AppError;
module.exports.AppError = AppError;
