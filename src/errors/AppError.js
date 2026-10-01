const formatProblemDetails = require("../utils/problemDetails");

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
 * Error code indicating that a job lease fencing token was rejected.
 * This is returned when a worker attempts a write/complete operation after
 * its lease has expired or been reassigned. It is non-retryable by default.
 * @type {string}
 */
Object.defineProperty(AppError, 'FENCING_TOKEN_REJECTED', {
  value: 'FENCING_TOKEN_REJECTED',
  writable: false,
  enumerable: true,
  configurable: false,
});

module.exports = AppError;