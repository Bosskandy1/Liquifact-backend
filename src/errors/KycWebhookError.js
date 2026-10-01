'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers.
 *
 * Carries an HTTP status and a machine-readable error code through the
 * Express error chain so that {@link module:middleware/kycWebhookErrorHandler}
 * can produce a consistent structured response without per-handler
 * duplication.
 *
 * ## Compatibility Contract
 *
 * Public API invariants:
 *   - `name` is always 'KycWebhookError' (string)
 *   - `message` is always a non-empty string
 *   - `status` is always a valid HTTP status code (number in 400-599 range)
 *   - `code` is always a non-empty string
 *   - All properties are immutable after construction
 *   - Constructor validates inputs and throws TypeError on invalid arguments
 *   - Safe serialization for logging (no circular references, no leaks)
 *
 * @module errors/KycWebhookError
 */

/**
 * Valid HTTP status codes for KYC webhook errors.
 * @type {Set<number>}
 */
const VALID_STATUS_CODES = new Set([
  400, 401, 403, 404, 409, 422, 429,
  500, 502, 503, 504
]);

/**
 * Lightweight error class that pairs an HTTP status with an application
 * error code for KYC webhook ingestion and listing endpoints.
 *
 * ## Invariants
 *   - All constructor parameters are required and validated
 *   - Properties are frozen after construction (immutable)
 *   - Status must be a valid HTTP error status code (4xx or 5xx)
 *   - Message and code must be non-empty strings
 *   - Safe for concurrent access (no mutable state)
 */
class KycWebhookError extends Error {
  /**
   * @param {string} message  - Human-readable error description.
   * @param {number} status   - HTTP status code (400, 401, 403, 500, 503, etc.).
   * @param {string} code     - Machine-readable error code (e.g. 'missing_secret').
   * @throws {TypeError} When parameters are invalid or missing.
   */
  constructor(message, status, code) {
    // Validate message
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('KycWebhookError: message must be a non-empty string');
    }

    // Validate status
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      throw new TypeError('KycWebhookError: status must be an integer');
    }
    if (!VALID_STATUS_CODES.has(status)) {
      throw new TypeError(
        `KycWebhookError: status must be a valid HTTP error code (got ${status})`
      );
    }

    // Validate code
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new TypeError('KycWebhookError: code must be a non-empty string');
    }

    super(message);

    // Freeze name to prevent tampering
    Object.defineProperty(this, 'name', {
      value: 'KycWebhookError',
      writable: false,
      enumerable: false,
      configurable: false,
    });

    // Define immutable properties
    Object.defineProperty(this, 'status', {
      value: status,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    Object.defineProperty(this, 'code', {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    // Capture stack trace, excluding constructor from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, KycWebhookError);
    }

    // Freeze the error instance to prevent any mutation
    Object.freeze(this);
  }

  /**
   * Custom serialization for safe logging and inspection.
   * Prevents circular references and ensures consistent output.
   *
   * @returns {object} Serialized error representation.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      stack: this.stack,
    };
  }

  /**
   * Custom inspection for Node.js util.inspect.
   * Provides clean output for debugging and logging.
   *
   * @returns {string} Formatted error string.
   */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `${this.name} [${this.code}]: ${this.message} (HTTP ${this.status})`;
  }
}

module.exports = KycWebhookError;
