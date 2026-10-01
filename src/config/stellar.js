'use strict';

/**
 * @fileoverview Stellar network configuration accessor with explicit boundary
 * contract preservation.
 *
 * Public contract invariants:
 * - getStellarConfig() always returns { rpcUrl: string, networkPassphrase: string }
 * - Both fields are non-null strings derived from validated config
 * - Throws Error with clear message if config.get() fails (not validated)
 * - Return shape is stable across upgrades; new fields require version bump
 * - No side effects; safe for concurrent calls and repeated invocation
 *
 * Failure modes:
 * - Config not validated → Error('Config not validated. Call validate() first.')
 * - Missing SOROBAN_RPC_URL → config validation rejects at boot (has default)
 * - Missing NETWORK_PASSPHRASE → config validation rejects at boot (has default)
 * - Invalid types → config validation enforces string/url types at boot
 *
 * @module config/stellar
 */

const config = require('./index');

/**
 * @typedef {Object} StellarConfig
 * @property {string} rpcUrl - Soroban RPC endpoint URL (validated at boot).
 * @property {string} networkPassphrase - Stellar network passphrase.
 */

/**
 * Get Stellar-specific configuration.
 *
 * Boundary contract:
 * - Returns a plain object with exactly two string properties: rpcUrl and networkPassphrase
 * - Both values are guaranteed non-empty strings validated at application boot
 * - Throws Error if config.get() hasn't been called (fail-fast on misconfiguration)
 * - Idempotent: repeated calls return equivalent objects with the same values
 * - Thread-safe: no mutable state, safe for concurrent access
 *
 * Compatibility notes:
 * - Return shape { rpcUrl, networkPassphrase } is the public contract
 * - Adding optional fields is backward-compatible; removing/renaming is breaking
 * - Callers must handle Error thrown when config is not validated
 * - Field values come from config module defaults if env vars are absent
 *
 * @returns {StellarConfig} Stellar configuration with validated rpcUrl and networkPassphrase.
 * @throws {Error} When config.validate() has not been called prior to invocation.
 */
function getStellarConfig() {
  // config.get() enforces that validate() was called; throws if not.
  // This is the primary fail-fast boundary: misconfigured apps crash early.
  const validatedConfig = config.get();

  // SOROBAN_RPC_URL and NETWORK_PASSPHRASE are guaranteed by ConfigSchema:
  // - SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org')
  // - NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015')
  // Both have defaults, so they are always present and type-validated.
  const rpcUrl = validatedConfig.SOROBAN_RPC_URL;
  const networkPassphrase = validatedConfig.NETWORK_PASSPHRASE;

  // Defensive invariant check: even though schema guarantees non-empty strings,
  // explicitly validate to preserve the public contract under schema evolution.
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) {
    throw new Error(
      'Stellar config invariant violated: SOROBAN_RPC_URL must be a non-empty string'
    );
  }

  if (typeof networkPassphrase !== 'string' || networkPassphrase.length === 0) {
    throw new Error(
      'Stellar config invariant violated: NETWORK_PASSPHRASE must be a non-empty string'
    );
  }

  // Return the stable public contract shape.
  // Frozen to prevent caller mutation that could break assumptions.
  return Object.freeze({
    rpcUrl,
    networkPassphrase,
  });
}

module.exports = { getStellarConfig };