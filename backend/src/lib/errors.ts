export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'VALIDATION_ERROR', msg, details);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Acceso denegado') => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'CONFLICT', msg, details);
export const tooMany = (msg = 'Demasiadas solicitudes, intente en un minuto') => new HttpError(429, 'RATE_LIMITED', msg);

/** Error de concurrencia que Step Functions reintenta (Retry ErrorEquals). */
export class ConcurrencyConflict extends Error {
  constructor(message = 'Conflicto de concurrencia; reintentar') {
    super(message);
    this.name = 'ConcurrencyConflict';
  }
}
