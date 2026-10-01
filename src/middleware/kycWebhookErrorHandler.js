'use strict';

/**
 * @fileoverview Shared error-handling middleware for KYC webhook routes.
 *
 * Intercepts {@link KycWebhookError} instances thrown by route handlers and
 * produces an RFC 7807 application/problem+json response via the canonical
 * problem-detail builder.
 *
 * Non-KycWebhookError values are forwarded to the next error handler in the
 * Express chain.
 *
 * Retryability and retry hints are delegated to {@link KycWebhookError#isRetryable}
 * and {@link KycWebhookError#toRetryHint} — the single authoritative source of
 * truth for those predicates — rather than duplicating the logic here.
 *
 * @module middleware/kycWebhookErrorHandler
 */

const KycWebhookError = require('../errors/KycWebhookError');
const formatProblemDetails = require('../utils/problemDetails');
const logger = require('../logger');
const { sanitizeTelemetryString } = require('../utils/telemetryRedaction');

/**
 * Express error-handling middleware for KYC webhook routes.
 *
 * Only handles {@link KycWebhookError} instances; all other errors are
 * forwarded to the next error handler.
 *
 * Emits RFC 7807 application/problem+json responses with type, title, status,
 * detail, instance, code, retryable, and retry_hint fields.
 *
 * @param {KycWebhookError} err - The intercepted error.
 * @param {import('express').Request}   req  - Express request.
 * @param {import('express').Response}  res  - Express response.
 * @param {import('express').NextFunction} next - Next error handler.
 * @returns {void}
 */
function kycWebhookErrorHandler(err, req, res, next) {
  if (!(err instanceof KycWebhookError)) {
    return next(err);
  }

  const correlationId = req.correlationId || req.id || 'unknown';

  // Delegate to the single-source-of-truth helpers on the error itself.
  const retryable = err.isRetryable();
  const retryHint = err.toRetryHint();

  // `err.message` is redacted here as a final, defense-in-depth choke point
  // for the log line specifically (issue #1200) — the messages that can
  // carry provider-controlled content are already sanitized at the point
  // they are constructed (see kycWebhookService.js), so this is a backstop
  // rather than the only line of defense.  `correlationId` is a value this
  // service generates itself, never provider input, so it is logged as-is.
  //
  // toLogContext() provides structured observability fields (code, status,
  // smeId, tenantId, requestId) without leaking raw error internals.
  logger.warn(
    {
      err: sanitizeTelemetryString(err.message),
      correlationId,
      ...err.toLogContext(),
    },
    'kyc-webhook error',
  );

  // Store the error code so the post-response metrics hook can read it.
  req._kycErrorCode = err.code;

  const problem = formatProblemDetails({
    type: formatProblemDetails.getProblemType(err.status),
    title: formatProblemDetails.getStandardTitle(err.status),
    status: err.status,
    detail: err.message,
    instance: req.originalUrl || req.url,
    code: err.code,
    retryable,
    retryHint,
  });

  res.status(err.status).type('application/problem+json').json(problem);
}

module.exports = kycWebhookErrorHandler;
