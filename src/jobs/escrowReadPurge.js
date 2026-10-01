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

/** @constant {number} Default purge cadence: 6 hours. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Minimum allowed purge interval.
 *
 * Values below this floor would schedule the job so aggressively that the
 * worker could starve normal request traffic.
 *
 * @constant {number}
 */
const MIN_INTERVAL_MS = 60_000; // 1 minute
/** @constant {number} */
const DEFAULT_MAX_RETRIES = 3;
/** @constant {number} */
const BASE_RETRY_DELAY_MS = 250;
/** @constant {number} */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Maximum allowed purge interval.
 *
 * Values above this ceiling would silently stall the purge: tombstones could
 * grow unbounded for days before the job fires. Seven days is chosen as the
 * outer safe bound — well beyond any reasonable maintenance window — so a
 * misconfigured large value is rejected rather than accepted silently.
 *
 * @constant {number}
 */
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Maximum allowed `delayMs` accepted by {@link schedulePurge}.
 *
 * Mirrors `MAX_INTERVAL_MS` so a scheduled delay cannot exceed one full purge
 * cycle. Values above this are clamped rather than rejected so callers can
 * pass `getIntervalMs()` directly without a separate guard.
 *
 * @constant {number}
 */
const MAX_DELAY_MS = MAX_INTERVAL_MS;

/**
 * Maximum rows the service layer accepts per batch (`MAX_PURGE_BATCH_SIZE` in
 * {@link module:services/escrowReadSoftDelete}). Duplicated here so the job
 * layer can clamp injected `batchSize` values without importing internal
 * service constants.
 *
 * @constant {number}
 */
const MAX_BATCH_SIZE = 10000;

/**
 * Maximum batch count the service layer accepts per run
 * (`MAX_PURGE_MAX_BATCHES` in {@link module:services/escrowReadSoftDelete}).
 * Duplicated here so the job layer can clamp injected `maxBatches` values
 * without importing internal service constants.
 *
 * @constant {number}
 */
const MAX_MAX_BATCHES = 1000;

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client 's registry is process-global, so a bare
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

const escrowReadPurgeRetriesTotal = _counter({
  name: 'liquifact_escrow_read_purge_retries_total',
  help: 'Total escrow-read purge retry attempts',
});

const escrowReadPurgeRowsDeletedOnRetryTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_on_retry_total',
  help: 'Total escrow-read tombstones deleted by retried runs',
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
 * Clamping is applied in both directions:
 * - Values below `MIN_INTERVAL_MS` (< 1 min) would schedule the job so
 *   aggressively that it could starve normal traffic.
 * - Values above `MAX_INTERVAL_MS` (> 7 days) would silently stall the purge,
 *   allowing tombstones to accumulate beyond their intended retention window.
 *
 * Non-numeric, non-finite, and non-integer inputs (e.g. floats, `"abc"`,
 * `Infinity`) all fall back to the safe default.
 *
 * @returns {number} Interval in ms, clamped to
 *   [`MIN_INTERVAL_MS`, `MAX_INTERVAL_MS`]; default 6 h.
 */
function getIntervalMs() {
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.min(parsed, MAX_INTERVAL_MS);
}

/**
 * Normalises a raw `job` argument into a safe plain object.
 *
 * The worker framework passes a job envelope, but callers (admin endpoints,
 * tests) may pass non-object values. Normalising avoids a crash when the
 * handler accesses `job.id`.
 *
 * @param {unknown} raw - Raw `job` argument.
 * @returns {{ id?: string }} Safe job envelope.
 */
function _normaliseJob(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  return {};
}

/**
 * Validates and sanitises the `options` forwarded to
 * {@link purgeExpiredSoftDeletes}.
 *
 * Only recognised fields are kept; unrecognised keys are dropped. Individual
 * fields are validated against their expected types and ranges:
 *
 * - `batchSize`  — must be a positive finite integer `number` (string values
 *   are rejected, not coerced); clamped to [1, `MAX_BATCH_SIZE`]; dropped if
 *   the type check fails.
 * - `maxBatches` — must be a positive finite integer `number` (string values
 *   are rejected, not coerced); clamped to [1, `MAX_MAX_BATCHES`]; dropped if
 *   the type check fails.
 * - `now`        — must be a finite number; dropped otherwise.
 * - `dbClient`   — any non-null object is forwarded as-is (test injection).
 *
 * Dropping an invalid field lets the service fall back to its own defaults
 * (from environment variables) rather than crashing or silently passing a
 * corrupt value into the DELETE query.
 *
 * @param {unknown} raw - Raw options argument.
 * @returns {object} Sanitised options object safe to pass to the service.
 */
function _sanitiseOptions(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const safe = {};

  // dbClient — opaque Knex instance injected by tests; validate it is an object.
  if (raw.dbClient !== null && raw.dbClient !== undefined) {
    if (typeof raw.dbClient === 'object' && !Array.isArray(raw.dbClient)) {
      safe.dbClient = raw.dbClient;
    }
    // Non-object dbClient is silently dropped; service uses its own default.
  }

  // now — must be a finite number (epoch ms). Non-finite or non-number is dropped.
  if (raw.now !== undefined) {
    if (typeof raw.now === 'number' && Number.isFinite(raw.now)) {
      safe.now = raw.now;
    }
    // Invalid `now` is dropped; service uses Date.now() as its own default.
  }

  // batchSize — must be a positive finite integer (not a string).
  // Clamped to [1, MAX_BATCH_SIZE] so callers cannot exceed the service limit.
  if (raw.batchSize !== undefined) {
    if (typeof raw.batchSize === 'number') {
      const bs = raw.batchSize;
      if (Number.isFinite(bs) && Number.isInteger(bs) && bs > 0) {
        safe.batchSize = Math.min(bs, MAX_BATCH_SIZE);
      }
    }
    // Non-number or invalid batchSize is dropped; service uses getPurgeBatchSize().
  }

  // maxBatches — must be a positive finite integer (not a string).
  // Clamped to [1, MAX_MAX_BATCHES] so callers cannot exceed the service limit.
  if (raw.maxBatches !== undefined) {
    if (typeof raw.maxBatches === 'number') {
      const mb = raw.maxBatches;
      if (Number.isFinite(mb) && Number.isInteger(mb) && mb > 0) {
        safe.maxBatches = Math.min(mb, MAX_MAX_BATCHES);
      }
    }
    // Non-number or invalid maxBatches is dropped; service uses getPurgeMaxBatches().
  }

  return safe;
}

/**
 * Reads the maximum number of retries for a failed purge run.
 *
 * @param {object} [options={}]
 * @param {number} [options.maxRetries] - Override for tests/callers.
 * @returns {number} Non-negative integer.
 */
function getMaxRetries(options = {}) {
  if (Number.isInteger(options.maxRetries) && options.maxRetries >= 0) {
    return options.maxRetries;
  }
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_MAX_RETRIES, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_RETRIES;
  }
  return parsed;
}

/**
 * Computes a deterministic exponential backoff delay for a retry attempt.
 *
 * @param {number} attempt - 1-based retry attempt number.
 * @returns {number} Delay in ms, capped at 30 s.
 */
function getRetryDelayMs(attempt) {
  const delay = BASE_RETRY_DELAY_MS * 2 ** (Math.max(1, attempt) - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Sleeps for the given duration. Exposed for testability via the options
 * bag so tests can inject a no-op sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-process mutex guard for the purge handler. */
let purgeInFlight = null;

/**
 * Resets the in-flight guard. Test-only hook to keep suites isolated.
 *
 * @returns {void}
 */
function _resetInFlight() {
  purgeInFlight = null;
}

/**
 * Runs a single purge attempt with metrics and structured logging.
 *
 * @param {object} job
 * @param {object} options
 * @param {number} attempt
 * @returns {Promise<object>}
 */
async function _attemptPurge(job, options, attempt) {
  const startedAt = Date.now();
  const summary = await purgeExpiredSoftDeletes(options);

  escrowReadPurgeRowsDeletedTotal.inc(summary.purged);
  if (attempt > 1) {
    escrowReadPurgeRowsDeletedOnRetryTotal.inc(summary.purged);
  }
  escrowReadPurgeRunsTotal.inc({ status: 'success' });

  logger.info(
    {
      jobId: job.id,
      attempt,
      purged: summary.purged,
      batches: summary.batches,
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays,
      maxBatchesReached: summary.maxBatchesReached,
      durationMs: Date.now() - startedAt,
    },
    'escrowReadPurge: run completed'
  );

  return { success: true, attempts: attempt, ...summary };
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
 * @throws {Error} Re-throws the underlying failure after recording metrics and
 *   exhausting retries so the worker's retry policy applies.
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

  const maxRetries = getMaxRetries(options);
  const sleep = typeof options.sleep === 'function' ? options.sleep : _sleep;

  const run = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        return await _attemptPurge(job, options, attempt);
      } catch (error) {
        lastError = error;
        escrowReadPurgeRunsTotal.inc({ status: 'error' });
        logger.error(
          {
            jobId: job.id,
            attempt,
            maxAttempts: maxRetries + 1,
            errorName: error.name,
            err: error.message,
          },
          'escrowReadPurge: attempt failed'
        );

        if (attempt > maxRetries) {
          break;
        }

        escrowReadPurgeRetriesTotal.inc();
        const delayMs = getRetryDelayMs(attempt);
        logger.warn(
          { jobId: job.id, attempt, delayMs },
          'escrowReadPurge: retrying after backoff'
        );
        await sleep(delayMs);
      }
    }

    throw lastError;
  })();

  purgeInFlight = run;
  try {
    const summary = await purgeExpiredSoftDeletes(safeOptions);

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
        jobId: safeJob.id,
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
 * `delayMs` is clamped to [0, `MAX_DELAY_MS`]:
 * - Negative values would trigger immediate execution regardless of intent,
 *   potentially creating a cascading storm of back-to-back purge runs.
 * - Values exceeding `MAX_DELAY_MS` (7 days) would silently stall the purge
 *   beyond any reasonable operational window.
 *
 * `NaN` and non-finite values fall back to the current interval so the queue
 * is always seeded with a valid delay.
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
      maxRetries: getMaxRetries(),
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
  getMaxRetries,
  getRetryDelayMs,
  _resetInFlight,
  purgeQueue,
  purgeWorker,
  // Exported for test introspection only -- do not depend on this in production code.
  get _purgeInFlight() { return _purgeInFlight; },
};