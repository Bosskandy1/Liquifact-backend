const AppError = require("./AppError");

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return "BAD_REQUEST";
  }
  if (status === 401) {
    return "UNAUTHORIZED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 409) {
    return "CONFLICT";
  }
  if (status === 422) {
    return "UNPROCESSABLE_ENTITY";
  }
  if (status === 429) {
    return "TOO_MANY_REQUESTS";
  }
  if (status === 500) {
    return "INTERNAL_SERVER_ERROR";
  }
  if (status === 503) {
    return "SERVICE_UNAVAILABLE";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  return `HTTP_${status}`;
}

/**
 * Normalize an AppError-like value into the stable error contract.
 *
 * This function is the single source of truth for the public shape of
 * mapped AppErrors. It is deliberately defensive against malformed or
 * partially constructed error objects so that callers always receive a
 * consistent {status, code, message, retryable, retryHint} tuple.
 *
 * @param {object} error AppError-like value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapAppError(error) {
  const rawStatus = error.status;
  const status =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : 500;

  const rawCode = error.code;
  const code =
    typeof rawCode === "string" && rawCode.length > 0
      ? rawCode
      : httpStatusToCode(status);

  // Prefer the explicit detail when present, otherwise fall back to the
  // canonical message. Never emit a non-string message to keep the contract
  // stable for downstream consumers.
  const rawMessage = error.detail ?? error.message;
  const message =
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : httpStatusToCode(status);

  const retryable = error.retryable === true;
  const rawRetryHint = error.retryHint;
  const retryHint = typeof rawRetryHint === "string" ? rawRetryHint : "";

  return { status, code, message, retryable, retryHint };
}

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * Invariants:
* - Always returns a new object with the exact keys {status, code, message,
 *   retryable, retryHint}.
 * - `status` is always a finite number.
 * - `code` and `message` are always non-empty strings.
 * - `retryable` is always a boolean and `retryHint` is always a string.
 * - No internal details (e.g. stack traces, upstream payloads) are leaked.
 *
 * @param {unknown} error Thrown error value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapError(error) {
  if (error && (error instanceof AppError || error.name === "AppError")) {
    return mapAppError(error);
  }

  if (
    error &&
    typeof error === "object" &&
    error.isCorsOriginRejected === true
  ) {
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "CORS policy: origin is not allowed.";
    return {
      status: 403,
      code: "FORBIDDEN",
      message,
      retryable: false,
      retryHint: "",
    };
  }

  if (isBodyParserSyntaxError(error)) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Malformed JSON request body.",
      retryable: false,
      retryHint: "Fix the JSON payload and try again.",
    };
  }

  if (error && typeof error === "object" && error.code === "ECONNREFUSED") {
    return {
      status: 503,
      code: "UPSTREAM_ERROR",
      message: "A dependent service is temporarily unavailable.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  if (error && typeof error === "object" && error.code === "CIRCUIT_OPEN") {
    return {
      status: 503,
      code: "CIRCUIT_OPEN",
      message:
        "Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  const rawStatus = error && error.status;
  const status =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : 500;
  const retryableStatuses = [429, 503];
  const retryable = retryableStatuses.includes(status);
  let retryHint = "Do not retry until the issue is resolved or support is contacted.";
  if (status === 429) {
    retryHint = "Wait for the rate limit window to reset before retrying.";
  } else if (status === 503) {
    retryHint = "Retry the request in a few moments.";
  }
  const rawMessage = error && error.message;
  const message =
    status === 500
      ? "An internal server error occurred."
      : typeof rawMessage === "string" && rawMessage.length > 0
        ? rawMessage
        : "An internal server error occurred.";
  return {
    status,
    code: httpStatusToCode(status),
    message,
    retryable,
    retryHint,
  };
}

/**
 * Detect Express JSON parser syntax errors.
 *
 * @param {unknown} error Thrown error value.
 * @returns {boolean}
 */
function isBodyParserSyntaxError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    error.type === "entity.parse.failed" &&
    error.status === 400,
  );
}

module.exports = {
  mapError,
  isBodyParserSyntayError,
};
