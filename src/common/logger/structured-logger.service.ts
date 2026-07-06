import { Injectable, LoggerService, LogLevel, Scope } from '@nestjs/common';

/** Ordered severities — anything below the configured threshold is dropped. */
const LEVEL_WEIGHT: Record<string, number> = {
  debug: 10,
  verbose: 15,
  log: 20,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structured JSON logger.
 *
 * Emits one JSON object per line (`{ ts, level, context, message, ... }`),
 * which is what Railway's log drains and most log aggregators expect. It is
 * registered as the Nest application logger in `main.ts`, so every
 * `new Logger(context)` call across the codebase is rendered as JSON.
 */
@Injectable({ scope: Scope.DEFAULT })
export class StructuredLogger implements LoggerService {
  private readonly threshold: number;

  constructor(logLevel: string = process.env.LOG_LEVEL ?? 'info') {
    this.threshold = LEVEL_WEIGHT[logLevel.toLowerCase()] ?? LEVEL_WEIGHT.info;
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('info', message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, optional);
  }

  setLogLevels?(_levels: LogLevel[]): void {
    // no-op: level is controlled via the LOG_LEVEL env var
  }

  /**
   * Emit a structured event with an explicit name and payload. Preferred over
   * free-text logging for machine-parseable events (sync runs, Claude calls…).
   */
  event(level: 'info' | 'warn' | 'error' | 'debug', name: string, data: Record<string, unknown>) {
    this.write(level, name, [data]);
  }

  private write(level: string, message: unknown, optional: unknown[]): void {
    if ((LEVEL_WEIGHT[level] ?? 20) < this.threshold) return;

    // Nest passes the logging context as the last string argument.
    let context: string | undefined;
    const extras: unknown[] = [...optional];
    if (extras.length > 0 && typeof extras[extras.length - 1] === 'string') {
      context = extras.pop() as string;
    }

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      context,
      message: this.stringifyMessage(message),
    };

    // Merge any object extras (structured metadata) onto the record.
    for (const extra of extras) {
      if (extra && typeof extra === 'object' && !(extra instanceof Error)) {
        Object.assign(record, extra);
      } else if (extra instanceof Error) {
        record.errorStack = extra.stack;
      } else if (extra !== undefined) {
        (record.details ??= []) as unknown[];
        (record.details as unknown[]).push(extra);
      }
    }

    const line = JSON.stringify(record, this.safeReplacer());
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  private stringifyMessage(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  /** Guard against circular references so a bad payload never crashes logging. */
  private safeReplacer() {
    const seen = new WeakSet();
    return (_key: string, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value && typeof value === 'object') {
        if (seen.has(value as object)) return '[Circular]';
        seen.add(value as object);
      }
      return value;
    };
  }
}
