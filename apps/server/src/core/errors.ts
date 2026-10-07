/** Erreur applicative portant un code HTTP et un code machine stable. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable.') {
    super(404, 'NOT_FOUND', message);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

/** La source distante (index HTTP, TMDB…) a répondu en erreur ou est injoignable. */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly upstreamStatus: number | null = null,
  ) {
    super(502, 'UPSTREAM_ERROR', message, upstreamStatus === null ? undefined : { upstreamStatus });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string) {
    super(503, code, message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
  );
}
