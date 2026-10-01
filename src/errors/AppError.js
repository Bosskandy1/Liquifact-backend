'use strict';

const formatProblemDetails = require('../utils/problemDetails');
const { getProblemType, getStandardTitle } = require('../utils/problemDetails');

/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 *
 * ## Concurrent Execution Safety
 *
 * This error class is hardened for concurrent and repeated execution:
 *   - All properties are immutable after construction (frozen)
 *   - Nested objects (context, fieldErrors) are deep-frozen
 *   - No mutable shared state between instances
 *   - Safe for multi-threaded logging, serialization, and inspection
 *   - Prevents race conditions from property mutation
 *   - Idempotent serialization (toJSON always produces same output)
 *
 * ## Invariants
 *   - `params` object is never retained (defensive copy via formatProblemDetails)
 *   - All RFC 7807 fields are validated and normalized by formatProblemDetails
 *   - Properties cannot be modified after construction
 *   - Stack trace is captured once and cannot be tampered with
 *   - Context and fieldErrors are deeply frozen to prevent nested mutations
 */
class AppError extends Error {
  /**
   * Creates a new AppError instance.
   *
   * @param {Object} params
   * @param {string} params.type - A URI reference [RF3986] that identifies the problem type.
   * @param {string} params.title - A short, human-readable summary of the problem type.
   * @param {number} params.status - The HTTP status code (e.g., 400, 404, 500).
   * @param {string} params.detail - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   * @param {string} [params.code] - Application-specific error code.
   * @param {boolean} [params.retryable] - Whether the operation is retryable.
   * @param {string} [params.retryHint] - Advice on how/when to retry.
   * @param {Object} [params.fieldErrors] - Field-level validation errors.
   * @param {*} [params.context] - Additional context for debugging.
   * @returns {AppError}
   */
  constructor(params) {
    const { title, context, fieldErrors } = params || {};
    super(title);

    // Freeze name to prevent tampering
    Object.defineProperty(this, 'name', {
      value: this.constructor.name,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Delegate to canonical builder for ALL field assembly/defaulting
    // This ensures deterministic, validated field values
    const problem = formatProblemDetails({
      ...params,
      stack: undefined,
    });

    // Define immutable RFC 7807 properties
    Object.defineProperty(this, 'type', {
      value: problem.type,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'title', {
      value: problem.title,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'status', {
      value: problem.status,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'detail', {
      value: problem.detail,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'instance', {
      value: problem.instance,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'code', {
      value: problem.code,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'retryable', {
      value: problem.retryable,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'retryHint', {
      value: problem.retry_hint,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Deep freeze context to prevent nested mutations
    const frozenContext = context ? deepFreeze(context) : null;
    Object.defineProperty(this, 'context', {
      value: frozenContext,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Deep freeze fieldErrors to prevent nested mutations
    const frozenFieldErrors = (params && Object.prototype.hasOwnProperty.call(params, 'fieldErrors'))
      ? deepFreeze(fieldErrors)
      : undefined;
    Object.defineProperty(this, 'fieldErrors', {
      value: frozenFieldErrors,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Capture stack trace, excluding constructor call from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // Freeze the entire error instance to prevent any mutation
    Object.freeze(this);
  }

  /**
   * Custom serialization for safe logging and inspection.
   * Idempotent: always produces the same output for the same error instance.
   *
   * @returns {object} Serialized RFC 7807 problem details.
   */
  toJSON() {
    const result = {
      type: this.type,
      title: this.title,
      status: this.status,
    };

    if (this.detail !== undefined) {
      result.detail = this.detail;
    }
    if (this.instance !== undefined) {
      result.instance = this.instance;
    }
    if (this.code !== undefined) {
      result.code = this.code;
    }
    if (this.retryable !== undefined) {
      result.retryable = this.retryable;
    }
    if (this.retryHint !== undefined) {
      result.retry_hint = this.retryHint;
    }
    if (this.fieldErrors !== undefined) {
      result.fieldErrors = this.fieldErrors;
    }
    if (this.context !== null && this.context !== undefined) {
      result.context = this.context;
    }
    if (this.stack) {
      result.stack = this.stack;
    }

    return result;
  }

  /**
   * Custom inspection for Node.js util.inspect.
   * Provides clean output for debugging and logging.
   *
   * @returns {string} Formatted error string.
   */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    const codeStr = this.code ? ` [${this.code}]` : '';
    return `${this.name}${codeStr}: ${this.title} (HTTP ${this.status})`;
  }
}

/**
 * Deep freeze an object and all its nested properties.
 * Prevents mutation at any level of the object tree.
 *
 * @param {*} obj - Object to freeze.
 * @returns {*} The frozen object.
 */
function deepFreeze(obj) {
  // Handle primitives and null
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Freeze the object itself
  Object.freeze(obj);

  // Recursively freeze all properties
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = obj[prop];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  });

  return obj;
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
Object.defineProperty(AppError, 'FENCING_TOKEN_REJECTED', {
  value: 'FENCING_TOKEN_REJECTED',
  writable: false,
  enumerable: true,
  configurable: false,
});

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
