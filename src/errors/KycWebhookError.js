'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers with deterministic
 * failure-recovery classification.
 *
 * Every `KycWebhookError` instance carries `retryable` and `retryHint` as
 * **owned properties**, computed once at construction from a central lookup
 * table keyed on `code` and `status`. This makes recovery behaviour
 * deterministic: callers can ask `err.retryable` without consulting separate
 * sets or switch statements in multiple files.
 *
 * ## Design contract
 *
 * - `retryable` is `true` only for transient infrastructure failures (503
 *   service unavailable, 429 rate-limited, open circuit breaker).  All
 *   semantic rejections (bad signature, unknown payload, tenant mismatch) are
 *   permanently non-retryable.
 * - `retryHint` mirrors retryability: it is either a safe, operator-facing
 *   string or the empty string `''` for non-retryable errors, never an
 *   internal detail.
 * - `status` and `retryable` are fully determined by `code` when the
 *   canonical factory `createKycWebhookError` is used, preventing
 *   status/code divergence across call sites.
 *
 * ## Backward compatibility
 *
 * The constructor signature `(message, status, code)` is unchanged.  Existing
 * `new KycWebhookError(msg, status, code)` call sites continue to work — they
 * now also get `retryable` / `retryHint` on the instance for free.
 *
 * @module errors/KycWebhookError
 */

const {
  KYC_WEBHOOK_ERROR_CODES,
} = require('../constants/kycWebhooks');

// ---------------------------------------------------------------------------
// Canonical recovery table
// ---------------------------------------------------------------------------

/**
 * Canonical table that maps every known KYC webhook error code to its
 * authoritative HTTP status, retryability flag, and client-facing retry hint.
 *
 * Keeping the table here — rather than duplicating it across the middleware,
 * service, and tests — is what makes failure recovery deterministic.
 *
 * @type {Readonly<Record<string, {status: number, retryable: boolean, retryHint: string}>>}
 */
const KYC_WEBHOOK_ERROR_RECOVERY = Object.freeze({
  // Transient / retryable
  [KYC_WEBHOOK_ERROR_CODES.MISSING_SECRET]: {
    status: 503,
    retryable: true,
    retryHint: 'Retry the request in a few moments.',
  },
  [KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN]: {
    status: 503,
    retryable: true,
    retryHint: 'Retry the request in a few moments.',
  },
  [KYC_WEBHOOK_ERROR_CODES.RATE_LIMITED]: {
    status: 429,
    retryable: true,
    retryHint: 'Wait for the rate limit window to reset before retrying.',
  },
  [KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR]: {
    status: 500,
    retryable: false,
    retryHint: '',
  },

  // Auth / signature — permanent, caller must fix the request
  [KYC_WEBHOOK_ERROR_CODES.MISSING_SIGNATURE]: {
    status: 401,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.INVALID_SIGNATURE]: {
    status: 401,
    retryable: false,
    retryHint: '',
  },

  // Payload / validation — permanent, caller must send a valid payload
  [KYC_WEBHOOK_ERROR_CODES.INVALID_PAYLOAD]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.INVALID_EVENT]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.UNKNOWN_EVENT_TYPE]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.MISSING_SME_ID]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.MISSING_STATUS]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.UNKNOWN_STATUS]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.INVALID_PAGINATION]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.INVALID_CURSOR]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE]: {
    status: 413,
    retryable: false,
    retryHint: '',
  },

  // AuthN / tenant — permanent
  [KYC_WEBHOOK_ERROR_CODES.TENANT_MISMATCH]: {
    status: 403,
    retryable: false,
    retryHint: '',
  },
  [KYC_WEBHOOK_ERROR_CODES.MISSING_TENANT_CONTEXT]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },

  // Quarantine — permanent
  [KYC_WEBHOOK_ERROR_CODES.QUARANTINED]: {
    status: 400,
    retryable: false,
    retryHint: '',
  },
});

// ---------------------------------------------------------------------------
// Fallback: derive retryability from HTTP status when code is unknown
// ---------------------------------------------------------------------------

/**
 * Retryable HTTP statuses used as a fallback when `code` is not in the
 * canonical recovery table.
 *
 * @type {ReadonlySet<number>}
 */
const RETRYABLE_STATUS_FALLBACK = Object.freeze(new Set([429, 503]));

/**
 * Derive a retry hint from the HTTP status alone (fallback only).
 *
 * @param {number} status - HTTP status code.
 * @returns {string}
 */
function retryHintFromStatus(status) {
  if (status === 429) {
    return 'Wait for the rate limit window to reset before retrying.';
  }
  if (status === 503) {
    return 'Retry the request in a few moments.';
  }
  return '';
}

// ---------------------------------------------------------------------------
// KycWebhookError class
// ---------------------------------------------------------------------------

/**
 * Structured, typed error for KYC webhook ingestion and listing endpoints.
 *
 * Carries HTTP status, machine-readable code, and deterministic recovery
 * metadata (`retryable`, `retryHint`) on every instance so that error
 * handlers and callers do not need to re-derive recovery behaviour.
 */
class KycWebhookError extends Error {
  /**
   * Creates a new KycWebhookError with deterministic recovery metadata.
   *
   * @param {string}          message  - Human-readable, safe error description.
   * @param {number}          status   - HTTP status code (400, 401, 403, 429, 500, 503 …).
   * @param {string}          code     - Machine-readable error code from KYC_WEBHOOK_ERROR_CODES.
   * @param {object}          [opts]   - Optional overrides.
   * @param {boolean}         [opts.retryable]  - Override computed retryable flag.
   * @param {string}          [opts.retryHint]  - Override computed retry hint.
   */
  constructor(message, status, code, opts = {}) {
    super(message);
    this.name = 'KycWebhookError';
    this.status = status;
    this.code = code;

    // Resolve recovery metadata from the canonical table, falling back to
    // status-based heuristics for codes not yet in the table.
    const recovery = code !== undefined ? KYC_WEBHOOK_ERROR_RECOVERY[code] : undefined;

    if (recovery !== undefined) {
      this.retryable = Object.prototype.hasOwnProperty.call(opts, 'retryable')
        ? Boolean(opts.retryable)
        : recovery.retryable;
      this.retryHint = Object.prototype.hasOwnProperty.call(opts, 'retryHint')
        ? String(opts.retryHint)
        : recovery.retryHint;
    } else {
      // Unknown / future code: fall back to status heuristics
      const retryableByStatus = RETRYABLE_STATUS_FALLBACK.has(status);
      this.retryable = Object.prototype.hasOwnProperty.call(opts, 'retryable')
        ? Boolean(opts.retryable)
        : retryableByStatus;
      this.retryHint = Object.prototype.hasOwnProperty.call(opts, 'retryHint')
        ? String(opts.retryHint)
        : retryHintFromStatus(status);
    }

    // Omit constructor call from stack trace for cleaner diagnostics.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: enforces code → status consistency
// ---------------------------------------------------------------------------

/**
 * Set of known KYC webhook error codes.  The factory validates against this
 * set to catch typos and code/status divergence at construction time.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_KYC_WEBHOOK_CODES = Object.freeze(
  new Set(Object.values(KYC_WEBHOOK_ERROR_CODES))
);

/**
 * Creates a `KycWebhookError` using the canonical status from the recovery
 * table, ensuring that every `(code, status)` pair is consistent across all
 * call sites.
 *
 * Prefer this factory over `new KycWebhookError(msg, status, code)` so that
 * the status is always derived from the code and cannot diverge.
 *
 * @param {string}  code     - Member of {@link KYC_WEBHOOK_ERROR_CODES}.
 * @param {string}  message  - Safe, human-readable description.
 * @param {object}  [opts]   - Optional overrides forwarded to the constructor.
 * @returns {KycWebhookError}
 * @throws {TypeError} When `code` is not a known KYC webhook error code.
 */
function createKycWebhookError(code, message, opts = {}) {
  if (!KNOWN_KYC_WEBHOOK_CODES.has(code)) {
    throw new TypeError(`Unknown KYC webhook error code: ${String(code)}`);
  }
  const recovery = KYC_WEBHOOK_ERROR_RECOVERY[code];
  const status = recovery ? recovery.status : 500;
  return new KycWebhookError(message, status, code, opts);
}

// ---------------------------------------------------------------------------
// Classifier: maps arbitrary thrown values to KycWebhookError
// ---------------------------------------------------------------------------

/**
 * Classifies an arbitrary thrown value into a `KycWebhookError`.
 *
 * - `KycWebhookError` instances are returned as-is.
 * - Objects with a known `code` in `KYC_WEBHOOK_ERROR_CODES` are promoted.
 * - Everything else becomes a generic 500 persistence/internal error so that
 *   internal messages (DB constraint text, stack traces) never cross the API
 *   boundary.
 *
 * @param {unknown} error - Thrown value from any KYC webhook handler.
 * @returns {KycWebhookError}
 */
function classifyKycWebhookError(error) {
  if (error instanceof KycWebhookError) {
    return error;
  }

  if (error && typeof error === 'object') {
    const code = error.code;
    if (code && KNOWN_KYC_WEBHOOK_CODES.has(code)) {
      return createKycWebhookError(
        code,
        typeof error.message === 'string' ? error.message : 'KYC webhook operation failed.',
      );
    }

    // Circuit-breaker: the circuit breaker uses a non-standard error code
    // string that might not be in the constants table.
    if (code === 'CIRCUIT_OPEN' || (error.message && String(error.message).includes('circuit'))) {
      return createKycWebhookError(
        KYC_WEBHOOK_ERROR_CODES.CIRCUIT_OPEN,
        'KYC webhook service is temporarily unavailable. Please retry.',
      );
    }
  }

  // Generic internal error — intentionally opaque to protect internals.
  return createKycWebhookError(
    KYC_WEBHOOK_ERROR_CODES.PERSISTENCE_ERROR,
    'An internal KYC webhook error occurred.',
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = KycWebhookError;
module.exports.KycWebhookError = KycWebhookError;
module.exports.KYC_WEBHOOK_ERROR_RECOVERY = KYC_WEBHOOK_ERROR_RECOVERY;
module.exports.KNOWN_KYC_WEBHOOK_CODES = KNOWN_KYC_WEBHOOK_CODES;
module.exports.createKycWebhookError = createKycWebhookError;
module.exports.classifyKycWebhookError = classifyKycWebhookError;
