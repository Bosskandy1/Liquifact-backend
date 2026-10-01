'use strict';

/**
 * @fileoverview Config DTO — deterministic failure recovery for application configuration.
 *
 * These helpers keep the route contract explicit and isolate DTO state from
 * caller mutations. They map plain objects to/from a small typed DTO envelope
 * that is easier to evolve safely during refactors.
 *
 * @module dto/config
 */

const { CONFIG_SECTIONS } = require('../schemas/config');

/**
 * Validate that a value is a plain record with only the allowed own keys.
 *
 * @param {unknown} value - Value to validate.
 * @param {string[]} allowedKeys - Keys accepted at this DTO boundary.
 * @param {string} label - Name used in the error message.
 * @param {string[]} requiredKeys - Keys that must be own properties.
 * @returns {Record<string, unknown>} The validated record.
 * @throws {TypeError} If the value is not a plain record or has extra keys.
 */
function requireRecord(value, allowedKeys, label, requiredKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new TypeError(`${label} contains unsupported fields`);
  }

  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing required fields`);
  }

  return value;
}

/**
 * Validate a known configuration section name.
 *
 * @param {unknown} section - Section value to validate.
 * @returns {string} The validated section name.
 * @throws {TypeError} If the section is not supported.
 */
function requireSection(section) {
  if (typeof section !== 'string' || !CONFIG_SECTIONS.includes(section)) {
    throw new TypeError('section must be a supported configuration section');
  }

  return section;
}

/**
 * Validate section-specific config as a plain record.
 * Field-level constraints remain the responsibility of the section schemas.
 *
 * @param {unknown} config - Config payload to validate.
 * @returns {Record<string, unknown>} A shallow copy of the validated config.
 * @throws {TypeError} If config is not a plain object.
 */
function requireConfig(config) {
  const allowedKeys = config && typeof config === 'object' && !Array.isArray(config)
    ? Object.keys(config)
    : [];
  const record = requireRecord(config, allowedKeys, 'config');
  return { ...record };
}

/**
 * @typedef {Object} AdminConfigRequestDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Section-specific configuration payload.
 */

/**
 * @typedef {Object} AdminConfigResponseDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Accepted section payload.
 * @property {string} message - Human-readable success message.
 */

/**
 * @typedef {Object} ConfigSectionsResponseDto
 * @property {string[]} sections - Valid configuration section names.
 */

/**
 * Copy config data so nested mutable values are not shared across DTO boundaries.
 * Config payloads are structured-cloneable JSON data after request validation.
 *
 * @param {Record<string, unknown>} config - Config payload to copy.
 * @returns {Record<string, unknown>} An independent config snapshot.
 */
function cloneConfig(config) {
  return structuredClone(config);
}

/**
 * Map a raw admin config request payload into a typed request DTO.
 *
 * @readonly
 * @enum {string}
 */
function toAdminConfigRequestDto(payload) {
  const record = requireRecord(payload, ['section', 'config'], 'request', ['section', 'config']);
  const section = requireSection(record.section);
  const config = requireConfig(record.config);

  // Build per-field error messages — strip raw values to avoid secret leakage.
  const formatted = zodError.format();
  const fieldErrors = /** @type {Record<string, string[]>} */ ({});
  for (const issue of zodError.issues) {
    const field = issue.path.join('.') || '_root';
    if (!fieldErrors[field]) fieldErrors[field] = [];
    // Use the Zod message but strip any embedded value that could be a secret.
    fieldErrors[field].push(_sanitizeZodMessage(issue.message));
  }
  void formatted; // used above for structure, messages taken from issues

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
    ? cloneConfig(payload.config)
    : {};

  return { section, config };
}

/**
 * Strip numeric literals and long strings from Zod issue messages to prevent
 * accidental secret exposure in structured error output.
 *
 * @param {string} msg - Raw Zod issue message.
 * @returns {string}
 */
function _sanitizeZodMessage(msg) {
  // Replace anything that looks like a raw value (quoted strings, long hex/tokens)
  return msg
    .replace(/"[^"]{8,}"/g, '"<redacted>"')
    .replace(/\b[a-f0-9]{16,}\b/gi, '<redacted>');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `ConfigDto` from a raw environment variables map.
 *
 * This function is **pure** — it does not read `process.env` directly and has
 * no module-level state, making it safe to call from tests and concurrent paths
 * without interference.
 *
 * @param {Record<string, string|undefined>} rawEnv - The env vars to parse.
 * @returns {ConfigDto} Validated, normalised DTO.
 * @throws {ConfigError} When validation fails. The error carries a structured
 *   `code` and `fieldErrors` map for deterministic failure handling.
 */
function toAdminConfigResponseDto(payload) {
  const record = requireRecord(payload, ['section', 'config', 'message'], 'response', ['section', 'config', 'message']);
  const section = requireSection(record.section);
  const config = requireConfig(record.config);
  if (typeof record.message !== 'string') {
    throw new TypeError('message must be a string');
  }

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
    ? cloneConfig(payload.config)
    : {};
  const message = typeof payload.message === 'string' ? payload.message : '';

  return { section, config, message };
}

/**
 * Parse the current `process.env` into a `ConfigResult`.
 *
 * Unlike `buildConfigDto`, this function **never throws** — all error paths
 * are normalised into `{ ok: false, error: ConfigError }` so callers get a
 * deterministic result regardless of input.
 *
 * Concurrent calls are safe: the function is stateless and re-entrant.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Env vars source.
 *   Override in tests to avoid mutating `process.env`.
 * @returns {ConfigResult}
 */
function parseConfigDto(env = process.env) {
  try {
    const dto = buildConfigDto(env);
    return { ok: true, dto };
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, error: err };
    }

/**
 * Map a list of config sections into the typed sections response DTO.
 *
 * @param {unknown} sections - Raw section list from the route boundary.
 * @returns {ConfigSectionsResponseDto} A normalized sections response DTO.
 */
function toConfigSectionsResponseDto(sections) {
  if (!Array.isArray(sections)) {
    throw new TypeError('sections must be an array');
  }

  const normalizedSections = sections.map(requireSection);
  if (new Set(normalizedSections).size !== normalizedSections.length) {
    throw new TypeError('sections must not contain duplicates');
  }

  return { sections: normalizedSections };
}

/**
 * Parse config and throw immediately on failure.
 *
 * Use this at boot time when the application should refuse to start rather than
 * operate with an invalid or partial configuration.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Env vars source.
 * @returns {ConfigDto} Validated DTO.
 * @throws {ConfigError} On any parse / validation failure.
 */
function fromConfigSectionsResponseDto(dto) {
  const record = requireRecord(dto, ['sections'], 'sections response', ['sections']);
  return toConfigSectionsResponseDto(record.sections);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildConfigDto,
  parseConfigDto,
  requireConfigDto,
  ConfigError,
  CONFIG_ERROR_CODES,
};
