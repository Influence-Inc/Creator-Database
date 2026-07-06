import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * Global exception filter. Produces a consistent JSON error envelope and maps
 * known Prisma errors to sensible HTTP statuses (e.g. unique-constraint → 409,
 * not-found → 404) instead of leaking a 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, details } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} -> ${status}: ${message}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(details ? { details } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private resolve(exception: unknown): {
    status: number;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : (((res as Record<string, unknown>).message as string) ?? exception.message);
      const details = typeof res === 'object' ? (res as Record<string, unknown>).errors : undefined;
      return { status: exception.getStatus(), message, details };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return { status: HttpStatus.BAD_REQUEST, message: 'Invalid database query' };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : 'Internal server error',
    };
  }

  private resolvePrisma(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
    details?: unknown;
  } {
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          message: 'A record with these unique values already exists',
          details: exception.meta,
        };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, message: 'Record not found' };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'Related record does not exist (foreign key constraint failed)',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: `Database error (${exception.code})`,
        };
    }
  }
}
