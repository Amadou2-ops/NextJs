import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";

import { AppError, NotFoundError, ValidationError, toAppError, toProblem } from "../lib/errors.js";

/**
 * Gestion centralisée des erreurs : réponse RFC 9457
 * (application/problem+json), journalisation adaptée à la gravité, aucune
 * information interne divulguée au client.
 */

export function notFound(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(new NotFoundError("Cette route n'existe pas."));
  };
}

interface BodyParserError {
  readonly type: string;
  readonly status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return typeof error === "object" && error !== null && "type" in error && typeof error.type === "string";
}

function fromBodyParser(error: BodyParserError): AppError | undefined {
  switch (error.type) {
    case "entity.too.large":
      return new AppError("PAYLOAD_TOO_LARGE", 413, "Requête trop volumineuse", {
        detail: "Le corps de la requête dépasse la taille autorisée.",
      });
    case "entity.parse.failed":
      return new ValidationError([{ path: "body", message: "JSON invalide" }], "Le corps de la requête n'est pas un JSON valide.");
    case "encoding.unsupported":
    case "charset.unsupported":
      return new AppError("UNSUPPORTED_MEDIA_TYPE", 415, "Encodage non supporté", {
        detail: "Seul le JSON encodé en UTF-8 est accepté.",
      });
    default:
      return undefined;
  }
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const appError = (isBodyParserError(error) ? fromBodyParser(error) : undefined) ?? toAppError(error);
    const logContext = {
      requestId: req.requestId,
      code: appError.code,
      status: appError.httpStatus,
      method: req.method,
      path: req.path,
      ...(appError.internalContext === undefined ? {} : { context: appError.internalContext }),
    };
    if (appError.isServerError) {
      logger.error({ ...logContext, err: appError.cause ?? appError }, "erreur serveur");
    } else if (appError.httpStatus === 401 || appError.httpStatus === 403 || appError.httpStatus === 429) {
      logger.warn(logContext, "requête refusée");
    } else {
      logger.debug(logContext, "requête rejetée");
    }

    if (appError.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(appError.retryAfterSeconds));
    if (appError.httpStatus === 401) res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');

    const problem = toProblem(appError, req.requestId, req.originalUrl.split("?")[0]);
    const send = (): void => {
      res.status(appError.httpStatus).type("application/problem+json").send(JSON.stringify(problem));
    };
    const handle = res.locals.idempotency;
    if (handle === undefined) {
      send();
      return;
    }
    delete res.locals.idempotency;
    handle
      .finalize(appError.httpStatus, problem)
      .then(send)
      .catch((finalizeError: unknown) => {
        logger.error({ requestId: req.requestId, err: finalizeError }, "échec d'enregistrement de la réponse idempotente");
        send();
      });
  };
}
