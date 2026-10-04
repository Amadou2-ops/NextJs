import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";

import { ValidationError } from "../lib/errors.js";
import type { FieldIssue } from "../lib/errors.js";

/**
 * Validation stricte des entrées par schémas Zod. Les données validées sont
 * exposées dans req.validated ; les contrôleurs n'utilisent jamais req.body
 * brut. Les schémas d'objets doivent être stricts (propriétés inconnues
 * refusées).
 */
export interface RequestSchemas {
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly params?: z.ZodType;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];
    const validated: { body?: unknown; query?: unknown; params?: unknown } = {};

    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (schema === undefined) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: [part, ...issue.path.map(String)].join("."), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new ValidationError(issues.slice(0, 50)));
      return;
    }
    req.validated = validated;
    next();
  };
}

/** Lecture typée des données validées dans un contrôleur. */
export function validatedBody<T extends z.ZodType>(req: Request, _schema: T): z.infer<T> {
  if (req.validated === undefined || !("body" in req.validated)) {
    throw new Error("validatedBody appelé sans middleware validate({ body })");
  }
  return req.validated.body as z.infer<T>;
}

export function validatedQuery<T extends z.ZodType>(req: Request, _schema: T): z.infer<T> {
  if (req.validated === undefined || !("query" in req.validated)) {
    throw new Error("validatedQuery appelé sans middleware validate({ query })");
  }
  return req.validated.query as z.infer<T>;
}

export function validatedParams<T extends z.ZodType>(req: Request, _schema: T): z.infer<T> {
  if (req.validated === undefined || !("params" in req.validated)) {
    throw new Error("validatedParams appelé sans middleware validate({ params })");
  }
  return req.validated.params as z.infer<T>;
}
