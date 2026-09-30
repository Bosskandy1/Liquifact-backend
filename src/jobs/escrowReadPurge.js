'use strict';

/**
 * @fileoverview Maintenance task that hard-deletes escrow-read records whose
 * soft-delete retention window has elapsed (issue #31).
 *
 * Soft-deleting a record (see {@link module:services/escrowReadSoftDelete})
 * leaves a tombstoned `escrow_event_projection` row behind. Without a purge,
 * tombstones accumulate forever the exact unbounded-growth problem the
 * idempotency purge job solves for `idempotency_keys`.
 *
 * This job runs the purge on a schedule through the shared job queue/worker
 * infrastructure, emits Prometheus counters, and exposes a manual trigger for
 * the admin API.
 *
 * ## State invariants
 * - Only one purge run may be in-flight at a time (`_purgeInFlight` guard).
 *   Concurrent runs would contend on the same tombstoned rows, potentially
 *   double-counting metrics or causing partial-delete races.
 * - `schedulePurge` is idempotent: a new job is only enqueued when no
 *   `escrow_read_purge` job is already pending, preventing queue growth under
 *   repeated admin triggers or restart loops.
 * - After each run (success or error) the next run is re-scheduled so the
 *   purge cadence is self-sustaining without manual intervention.
 * - Metric increments are always called with a validated, finite number so
 *   Prometheus counters never receive NaN/undefined.
 * - `maxBatchesReached` is surfaced as a dedicated counter so silent
 *   data-accumulation is observable.
 * - Errors are logged with the full stack trace (not just `message`) so
 *   failures are diagnosable without exposing sensitive row data.
 *
 * ## Configuration
 * - `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` -- restore/retention window (default 30).
 * - `ESCROW_READ_PURGE_BATCH_SIZE` -- rows deleted per batch (default 500).
 * - `ESCROW_READ_PURGE_MAX_BATCHES` -- batch cap per run (default 100).
 * - `ESCROW_READ_PURGE_INTERVAL_MS` -- cadence between runs (default 6 h, min 1 min).
 *
 * @module jobs/escrowReadPurge
 */

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/escrowReadSoftDelete');

/** @constant {string} */
const JOB_TYPE = 'escrow_read_purge';
/** @constant {number} */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** @constant {number} */
const MIN_INTERVAL_MS = 60_000; // 1 minute

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client`'s registry is process-global, so a bare
 * `new Counter(...)` would throw "already registered" on the second load.
 *
 * @param {object} config - `prom-client` counter configuration.
 * @returns {import('prom-client').Counter} New or previously registered counter.
 */
function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const escrowReadPurgeRowsDeletedTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_total',
  help: 'Total escrow-read tombstones hard-deleted after their retention window',
});

const escrowReadPurgeRunsTotal = _counter({
  name: 'liquifact_escrow_read_purge_runs_total',
  help: 'Total escrow-read purge job runs by outcome',
  labelNames: ['status'],
});

/**
 * Incremented whenever a run hits the batch cap, signalling that tombstones
 * remain and the next scheduled run will continue the work.
 */
const escrowReadPurgeMaxBatchesTotal = _counter({
  name: 'liquifact_escrow_read_purge_max_batches_reached_total',
  help: 'Number of purge runs that were capped by maxBatches (backlog present)',
});

/**
 * Single-flight guard -- true while a purge run is executing.
 *
 * Invariant: only one call to `purgeExpiredSoftDeletes` may be active at any
 * time. The worker already serialises via `maxConcurrency: 1`, but this flag
 * provides an explicit, testable safety net against re-entrant or out-of-band
 * calls (e.g. concurrent admin triggers processed by two worker instances).
 *
 * @type {boolean}
 */
let _purgeInFlight = false;

/**
 * Reads the purge cadence.
 *
 * @returns {number} Interval in ms (minimum 60000; default 6 h).
 */
function getIntervalMs() {
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Job handler: purges expired escrow-read tombstones and records metrics.
 *
 * ## Invariants enforced
 * - Single-flight: if a run is already in progress the handler returns early
 *   without touching the database, preventing concurrent mutation of the same
 *   tombstoned rows.
 * - Metric increments always receive a finite number; an unexpected summary
 *   shape results in 0 rather than NaN.
 * - The next scheduled run is enqueued unconditionally after every execution
 *   (success or error) so the purge cadence is self-sustaining.
 * - The full error stack is logged so failures are diagnosable.
 *
 * @param {object} [job={}] - Job envelope from the queue (`id` used for logs).
 * @param {object} [options={}] - Forwarded to
 *   {@link module:services/escrowReadSoftDelete.purgeExpiredSoftDeletes}
 *   (`dbClient`, `now`, `batchSize`, `maxBatches`) -- used by tests.
 * @returns {Promise<object>} Purge summary plus `success: true`.
 * @throws {Error} Re-throws the underlying failure after recording metrics so
 *   the worker's retry policy applies.
 */
async function runEscrowReadPurge(job = {}, options = {}) {
  // Invariant: no concurrent purge runs.
  if (_purgeInFlight) {
    logger.warn(
      { jobId: job.id },
      'escrowReadPurge: run skipped -- previous run still in-flight'
    );
    return { success: false, skipped: true };
  }

  _purgeInFlight = true;
  const startedAt = Date.now();

  try {
    const summary = await purgeExpiredSoftDeletes(options);

    // Invariant: always increment with a finite number to avoid NaN in metrics.
    const purgedCount = Number.isFinite(summary && summary.purged) ? summary.purged : 0;
    escrowReadPurgeRowsDeletedTotal.inc(purgedCount);
    escrowReadPurgeRunsTotal.inc({ status: 'success' });

    // Invariant: surface batch-cap events so operators can observe backlog.
    if (summary && summary.maxBatchesReached) {
      escrowReadPurgeMaxBatchesTotal.inc();
    }

    logger.info(
      {
        jobId: job.id,
        purged: summary.purged,
        batches: summary.batches,
        cutoff: summary.cutoff,
        retentionDays: summary.retentionDays,
        maxBatchesReached: summary.maxBatchesReached,
        durationMs: Date.now() - startedAt,
      },
      'escrowReadPurge: run completed'
    );

    return { success: true, ...summary };
  } catch (error) {
    escrowReadPurgeRunsTotal.inc({ status: 'error' });
    // Log full stack so failures are diagnosable without exposing row data.
    logger.error(
      {
        jobId: job.id,
        err: error.message,
        stack: error.stack,
        durationMs: Date.now() - startedAt,
      },
      'escrowReadPurge: run failed'
    );
    throw error;
  } finally {
    // Always release the guard and re-schedule, regardless of outcome.
    _purgeInFlight = false;
    // Invariant: purge cadence is self-sustaining -- reschedule after every run.
    schedulePurge();
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Serialised: concurrent purges would contend on the same rows.
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runEscrowReadPurge(job));

/**
 * Enqueues a purge run only when no pending run already exists.
 *
 * Invariant: the queue must never accumulate more than one pending
 * `escrow_read_purge` job. Duplicate jobs would cause back-to-back runs that
 * contend on the same rows and inflate metrics. This guard makes
 * `schedulePurge` idempotent under repeated calls (e.g. start + admin trigger,
 * restart loops).
 *
 * @param {object} [options={}]
 * @param {number} [options.delayMs=getIntervalMs()] - Delay before execution.
 * @returns {string|null} Job ID, or `null` if a pending job already existed.
 */
function schedulePurge(options = {}) {
  // Invariant: only one pending purge job at a time.
  const qStats = purgeQueue.getStats();
  if (qStats && qStats.pending > 0) {
    logger.debug(
      { pending: qStats.pending },
      'escrowReadPurge: skipping schedule -- pending job already queued'
    );
    return null;
  }

  const delayMs = options.delayMs ?? getIntervalMs();
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });
  logger.debug({ jobId, delayMs }, 'escrowReadPurge: scheduled run');
  return jobId;
}

/**
 * Starts the worker and schedules the first run. Safe to call twice.
 *
 * @returns {void}
 */
function startPurgeWorker() {
  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'escrowReadPurge: worker started'
    );
  }
}

/**
 * Stops the worker, allowing in-flight runs to finish.
 *
 * @param {number} [timeoutMs=10000] - Grace period.
 * @returns {Promise<void>}
 */
async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  logger.info('escrowReadPurge: worker stopped');
}

/**
 * Triggers a purge immediately (admin endpoint / operational runbooks).
 *
 * Idempotent: if a pending job already exists the request is dropped and
 * `null` is returned -- the existing job will run imminently.
 *
 * @returns {string|null} Job ID, or `null` when a pending job already existed.
 */
function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

/**
 * Worker/queue/config snapshot for monitoring.
 *
 * @returns {object} `{ worker, queue, config }`
 */
function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
    },
  };
}

module.exports = {
  JOB_TYPE,
  runEscrowReadPurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
  // Exported for test introspection only -- do not depend on this in production code.
  get _purgeInFlight() { return _purgeInFlight; },
};