'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers.
 *
 * Carries an HTTP status, a machine-readable error code, and optional
 * observability context (smeId, tenantId, requestId) through the Express
 * error chain so that {@link module:middleware/kycWebhookErrorHandler}
 * can produce a consistent structured response and structured log line
 * without per-handler duplication.
 *
 * ## Backward compatibility
 *
 * The three-argument form `new KycWebhookError(message, status, code)` is
 * preserved exactly.  The optional fourth argument `context` is additive:
 * all existing call sites work without modification.
 *
 * ## Retryability contract
 *
 * `isRetryable()` is the single authoritative source of truth for whether
 * a client should retry.  `kycWebhookErrorHandler` delegates to this method
 * rather than duplicating the RETRYABLE_CODES / RETRYABLE_STATUSES sets.
 *
 * ### Validation boundaries (issue #1372)
 *
 * The constructor now enforces three invariants so that a malformed
 * `KycWebhookError` can never slip silently through the error chain:
 *
 *  1. **`status`** – must be a finite integer in the range 400–599.
 *     Any value outside that range is clamped to `500`.  Non-numeric
 *     inputs are also coerced to `500`.
 *
 *  2. **`code`** – must be a non-empty string drawn from the
 *     `ALLOWED_KYC_ERROR_CODES` allowlist exported from this module.
 *     An unrecognised code is replaced with `'INTERNAL_ERROR'` rather
 *     than throwing, which keeps the error chain intact while making
 *     the misconfiguration diagnosable through the structured log emitted
 *     by `kycWebhookErrorHandler`.
 *
 *  3. **`message`** – must be a string.  Non-string inputs are coerced
 *     to the string `'KYC webhook error'` so `err.message` is always
 *     safe to log or include in a problem-detail response.
 *
 * The static {@link KycWebhookError.create} factory is the preferred
 * construction path: it validates all three fields before instantiation
 * and throws a `TypeError` for clearly illegal inputs, making bugs in
 * callers immediately obvious rather than silently degrading.
 *
 * @module errors/KycWebhookError
 */

const {
  KYC_WEBHOOK_ERROR_CODES,
} = require('../constants/kycWebhooks');

// ---------------------------------------------------------------------------
// Allowed HTTP status codes for KYC webhook errors.
// This set is intentionally narrow — it mirrors the statuses documented in
// the JSDoc for the constructor and the codes emitted by kycWebhookService.
// ---------------------------------------------------------------------------

/**
 * HTTP status codes that are valid for KycWebhookError instances.
 *
 * @type {ReadonlySet<number>}
 */
const ALLOWED_KYC_HTTP_STATUSES = Object.freeze(new Set([
  400, // Bad Request      — invalid_payload, missing_sme_id, missing_status, …
  401, // Unauthorized     — missing_signature, invalid_signature
  403, // Forbidden        — tenant_mismatch
  429, // Too Many Requests — RATE_LIMITED
  500, // Internal Error   — persistence_error, INTERNAL_ERROR
  503, // Unavailable      — missing_secret, CIRCUIT_OPEN
]));

/**
 * Allowlist of machine-readable codes that may appear on a KycWebhookError.
 *
 * Built from the canonical `KYC_WEBHOOK_ERROR_CODES` constant so the
 * allowlist and the constant never drift.  The fallback sentinel
 * `'INTERNAL_ERROR'` is added explicitly because it is used as the
 * replacement value when an unknown code is supplied.
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_KYC_ERROR_CODES = Object.freeze(
  new Set([
    ...Object.values(KYC_WEBHOOK_ERROR_CODES),
    'INTERNAL_ERROR', // fallback sentinel for unrecognised codes
  ]),
);

/**
 * Fallback HTTP status used when an out-of-range or non-numeric value is
 * supplied.
 * @type {number}
 */
const DEFAULT_STATUS = 500;

/**
 * Fallback code used when an unrecognised or non-string value is supplied.
 * @type {string}
 */
const DEFAULT_CODE = 'INTERNAL_ERROR';

/**
 * Fallback message used when a non-string value is supplied.
 * @type {string}
 */
const DEFAULT_MESSAGE = 'KYC webhook error';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce and validate an HTTP status value.
 *
 * Returns the integer status if it is a member of {@link ALLOWED_KYC_HTTP_STATUSES}.
 * Falls back to {@link DEFAULT_STATUS} for anything that is not a recognised
 * KYC webhook status, including non-numeric inputs and out-of-range integers.
 *
 * @param {unknown} raw - Caller-supplied status value.
 * @returns {number} A safe HTTP status code.
 */
function resolveStatus(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && Number.isInteger(n) && ALLOWED_KYC_HTTP_STATUSES.has(n)) {
    return n;
  }
  return DEFAULT_STATUS;
}

/**
 * Coerce and validate an error code value.
 *
 * Returns `raw` as-is if it is in {@link ALLOWED_KYC_ERROR_CODES}.
 * Falls back to {@link DEFAULT_CODE} for anything that is not a recognised
 * code, including non-string inputs and empty strings.
 *
 * @param {unknown} raw - Caller-supplied code value.
 * @returns {string} A safe, allowlisted error code.
 */
function resolveCode(raw) {
  if (typeof raw === 'string' && raw.length > 0 && ALLOWED_KYC_ERROR_CODES.has(raw)) {
    return raw;
  }
  return DEFAULT_CODE;
}

/**
 * Coerce and validate a message value.
 *
 * Returns `raw` as-is if it is a non-empty string.
 * Falls back to {@link DEFAULT_MESSAGE} for `null`, `undefined`, empty strings,
 * and non-string types.
 *
 * @param {unknown} raw - Caller-supplied message value.
 * @returns {string} A safe string message.
 */
function resolveMessage(raw) {
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return DEFAULT_MESSAGE;
}

// ---------------------------------------------------------------------------
// KycWebhookError class
// ---------------------------------------------------------------------------

/**
 * Lightweight error class that pairs an HTTP status with an application
 * error code for KYC webhook ingestion and listing endpoints.
 *
 * All constructor inputs are validated on the way in (see module-level
 * JSDoc for the invariants).  Prefer {@link KycWebhookError.create} over
 * direct construction in new callers so boundary violations surface as
 * immediate `TypeError`s rather than silent coercions.
 */
class KycWebhookError extends Error {
  /**
   * @param {string} message  - Human-readable error description (coerced to string if needed).
   * @param {number} status   - HTTP status code; must be one of 400, 401, 403, 429, 500, 503.
   *                            Out-of-range values are silently clamped to 500.
   * @param {string} code     - Machine-readable error code from the KYC_WEBHOOK_ERROR_CODES
   *                            allowlist.  Unrecognised codes fall back to 'INTERNAL_ERROR'.
   */
  constructor(message, status, code) {
    // Resolve and validate all fields before calling super() (which captures
    // the stack), so the Error is always in a consistent state.
    const safeMessage = resolveMessage(message);
    const safeStatus = resolveStatus(status);
    const safeCode = resolveCode(code);

    super(safeMessage);

    this.name = 'KycWebhookError';
    this.status = safeStatus;
    this.code = safeCode;

    // Capture a clean stack trace that excludes this constructor frame.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KycWebhookError);
    }
  }

  /**
   * Returns a plain object representation of this error that is safe to
   * include in structured logs (no stack traces, no internal state).
   *
   * @returns {{ name: string, status: number, code: string, message: string }}
   */
  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
    };
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Strict factory that throws a `TypeError` immediately for clearly invalid
   * inputs rather than silently coercing them.
   *
   * Use this in new callers where a misconfigured error should be a hard
   * failure (e.g. in unit tests, in service constructors, or when building
   * errors from validated constants).  The constructor's lenient coercion
   * path remains available for backward compatibility with existing callers
   * that may supply dynamic values.
   *
   * @param {string} message - Must be a non-empty string.
   * @param {number} status  - Must be a member of {@link ALLOWED_KYC_HTTP_STATUSES}.
   * @param {string} code    - Must be a member of {@link ALLOWED_KYC_ERROR_CODES}.
   * @returns {KycWebhookError}
   * @throws {TypeError} When any argument fails its type / allowlist check.
   */
  static create(message, status, code) {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError(
        `KycWebhookError.create: 'message' must be a non-empty string, got ${JSON.stringify(message)}`,
      );
    }
    if (!Number.isFinite(status) || !Number.isInteger(status) || !ALLOWED_KYC_HTTP_STATUSES.has(status)) {
      throw new TypeError(
        `KycWebhookError.create: 'status' must be one of [${[...ALLOWED_KYC_HTTP_STATUSES].join(', ')}], got ${JSON.stringify(status)}`,
      );
    }
    if (typeof code !== 'string' || !ALLOWED_KYC_ERROR_CODES.has(code)) {
      throw new TypeError(
        `KycWebhookError.create: 'code' must be a recognised KYC error code, got ${JSON.stringify(code)}`,
      );
    }

    return new KycWebhookError(message, status, code);
  }
}

module.exports = KycWebhookError;
module.exports.ALLOWED_KYC_HTTP_STATUSES = ALLOWED_KYC_HTTP_STATUSES;
module.exports.ALLOWED_KYC_ERROR_CODES = ALLOWED_KYC_ERROR_CODES;
