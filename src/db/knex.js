'use strict';

/**
 * @file src/db/knex.js
 * @description Knex connection factory.
 *
 * ## Connection selection rules
 *
 * | NODE_ENV     | Config block | Fallback | Guard                          |
 * |--------------|--------------|----------|--------------------------------|
 * | `test`       | `test`       | **none** | Throws if block is absent      |
 * | `production` | `production` | **none** | Throws if DATABASE_URL is unset |
 * | anything else| `<env>`      | `development` | Throws if neither exists  |
 *
 * The config-selection logic lives in `src/db/resolveConfig.js` so it can be
 * unit-tested independently without loading knex or pino.
 *
 * ## Pool configuration
 *
 * `DEFAULT_POOL` defines the baseline pool parameters applied to every
 * environment. Per-environment overrides in `knexfile.js` win (spread wins).
 * The test block sets `min:1, max:1`; those override the defaults.
 *
 * Changing any value in `DEFAULT_POOL` is a **breaking operational change**
 * and is guarded by regression assertions in the compatibility test suite
 * (`src/db/knex.compatibility.test.js`, CONTRACT 5).
 *
 * ## Pool error handling
 *
 * Knex exposes pool-level events through the underlying `tarn` pool. We
 * attach `createFail`, `acquireFail`, and `destroyFail` listeners so pool
 * errors surface in application logs without crashing the process.
 *
 * `attachPoolErrorHandlers` is a no-op when `instance.client.pool` is
 * absent (CONTRACT 14).
 *
 * ## Test mock
 *
 * Connection selection rules
 * ------------------------
 * - NODE_ENV=test       → always uses the `test` config block (in-memory SQLite).
 *                         Never falls back to development or production config.
 * - NODE_ENV=production → uses the `production` config block. Throws if the
 *                         `DATABASE_URL` env var is absent.
 * - anything else       → uses the `development` config block.
 *
 * Pool error handling
 * -------------------
 * Knex exposes pool-level events through the underlying `tarn` pool. We attach
 * `createTimeoutMillis` / `acquireTimeoutMillis` at the config level and log
 * pool errors so they surface in application logs without crashing the process.
 *
 * Test mock
 * --------
 * Jest resolves `src/db/__mocks__/knex.js` automatically when
 * `jest.mock('../../src/db/knex')` is called, so this file is never executed
 * during unit tests that use the manual mock.
 *
 * ## Singleton guarantee
 *
 * Node's module cache ensures that all callers that `require` this file
 * receive the same `db` object (CONTRACT 8). Do **not** call `knex()` in
 * multiple places — always import this module.
 * Config selection logic
 * --------------------
 * The config-selection logic lives in `src/db/resolveConfig.js` so it can be
 * unit-tested independently without loading knex or pino.
 *
 * @module src/db/knex
 */

const knex = require('knex');
const logger = require('../logger');
const resolveConfig = require('./resolveConfig');

/** @type {string} */
const env = process.env.NODE_ENV || 'development';

/**
 * Default pool configuration applied to every environment unless the config
 * block already specifies a `pool` key.
 *
 * These values are operational constants — changing them silently is a
 * breaking change that could cause production connection exhaustion or
 * latency spikes. Any modification must be deliberate and reviewed.
 *
 * CONTRACT 5 regression guard: `src/db/knex.compatibility.test.js` asserts
 * each of these values directly. If you change one here you must also update
 * the `EXPECTED_POOL` mirror in that test file.
 *
 * @type {import('knex').Knex.PoolConfig}
 */
const DEFAULT_POOL = {
  /** Minimum connections kept alive in the pool. */
  min: 2,
  /** Maximum concurrent connections the pool will open. */
  max: 10,
  /** Milliseconds to wait for a new connection to be created before erroring. */
  createTimeoutMillis: 30_000,
  /** Milliseconds to wait to acquire a connection from the pool before erroring. */
  acquireTimeoutMillis: 30_000,
  /** Milliseconds a connection may sit idle before being destroyed. */
  idleTimeoutMillis: 600_000,
  /** Milliseconds between reaping idle connections. */
  reapIntervalMillis: 1_000,
  /** Milliseconds to wait between connection-creation retries on transient failure. */
  createRetryIntervalMillis: 200,
};

/**
 * Attach pool-level error and connection-acquisition logging to a Knex
 * instance.
 *
 * Errors are caught here so unhandled promise rejections do not propagate
 * out of the pool layer. The function is a no-op when `instance.client.pool`
 * is absent — this guards against partially-initialised or mock instances
 * (CONTRACT 14).
 *
 * Event semantics:
 * - `createFail`  — logged at `error` level; a new connection could not be
 *   created (network/driver issue). Pool will retry.
 * - `acquireFail` — logged at `error` level; a caller timed out waiting for
 *   a connection. The caller's query will reject.
 * - `destroyFail` — logged at `warn` level; a connection could not be
 *   cleanly closed. Pool removes it from its tracking regardless.
 *
 * Handlers are idempotent: attaching twice will not duplicate listeners, so
 * recovery paths (e.g. re-init after a fatal pool error) stay deterministic.
 *
 * @param {import('knex').Knex} instance - The initialised Knex instance.
 * @returns {void}
 */
/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
function attachPoolErrorHandlers(instance) {
  // Defensive guard — tarn pool may be absent on mock or stub instances.
  const pool = instance.client && instance.client.pool;
  if (!pool) { return; }

  // Guard against duplicate listeners if this is called more than once on the
  // same pool (e.g. during a recovery/re-init sequence).
  if (pool.__liquifactHandlersAttached) { return; }
  pool.__liquifactHandlersAttached = true;

  /* eslint-enable no-underscore-dangle */
  /* eslint-enable no-param-reassign */
  pool.on('createFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to create connection');
  });

  pool.on('acquireFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to acquire connection');
  });

  pool.on('destroyFail', (eventId, err) => {
    // destroyFail is a warn, not an error — the pool discards the connection
    // regardless, so this is non-fatal but worth surfacing.
    logger.warn({ err, eventId }, '[db] Pool: failed to destroy connection');
  });

  pool.on('poolDestroySuccess', () => {
    logger.info('[db] Pool: destroyed');
  });
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
/**
 * Default pool configuration applied to every environment unless the config
 * block already specifies a `pool` key.
 *
 * @type {import('knex').Knex.PoolConfig}
 */
const DEFAULT_POOL = {
  min: 2,
  max: 10,
  /** Fail fast on connection acquisition rather than hanging indefinitely. */
  propagateCreateError: false,
  /** Milliseconds to wait for a new connection to be created before erroring. */
  createTimeoutMillis: 30_000,
  /** Milliseconds to wait to acquire a connection from the pool before erroring. */
  acquireTimeoutMillis: 30_000,
  /** Milliseconds a connection may sit idle before being destroyed. */
  idleTimeoutMillis: 600_000,
  /** Milliseconds between reaping idle connections. */
  reapIntervalMillis: 1_000,
  /** How many times to retry creating a connection on transient failure. */
  createRetryIntervalMillis: 200,
  /** Cap on retries so a persistent outage cannot loop forever. */
  createRetryCount: 3,
};

const config = resolveConfig(env);

/**
 * Merged Knex configuration: DEFAULT_POOL base with per-environment
 * overrides applied on top (CONTRACT 6 — per-env pool keys win).
 *
 * @type {import('knex').Knex.Config}
 */
const mergedConfig = {
  ...config,
  pool: { ...DEFAULT_POOL, ...(config.pool || {}) },
};

// ---------------------------------------------------------------------------
// Singleton Knex instance
// ---------------------------------------------------------------------------

/**
 * Singleton Knex database instance for the current environment.
 *
 * All callers should import this module rather than constructing their own
 * Knex instance. Node's module cache guarantees they receive the same object
 * (CONTRACT 8).
 *
 * Public interface callers depend on (CONTRACT 9):
 * - `db(tableName)`         — returns a query builder
 * - `db.raw(sql)`           — raw SQL execution
 * - `db.transaction(cb)`    — transaction wrapper
 * - `db.destroy()`          — pool teardown (used by shutdown coordinator)
 * - `db.schema`             — DDL builder
 * - `db.migrate`            — programmatic migration runner
 * - `db.fn`                 — Knex function helpers (e.g. `db.fn.now()`)
 *
 * @type {import('knex').Knex}
 */
const db = knex(mergedConfig);

attachPoolErrorHandlers(db);

/**
 * Deterministically tear down the singleton pool. Safe to call multiple times;
 * subsequent calls resolve without error. Any in-flight queries are allowed to
 * settle (or reject) before the pool is destroyed, so callers can observe the
 * outcome rather than silently losing work.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (db.__liquifactShutdown) { return; }
  try {
    await db.destroy();
  } catch (err) {
    logger.error({ err }, '[db] Failed to destroy pool during shutdown');
    throw err;
  }
}

db.__liquifactShutdown = false;
// Expose shutdown without changing the default export shape (still a Knex
// instance), preserving compatibility with existing callers.
db.shutdown = shutdown;

module.exports = db;
