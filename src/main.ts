import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { StructuredLogger } from './common/logger/structured-logger.service';

// Last-resort handlers so a failure during module evaluation or an async
// rejection is always surfaced (and the process doesn't die silently before
// the platform's log shipper flushes).
process.on('uncaughtException', (err) => {
  process.stderr.write(`[fatal] uncaughtException: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[fatal] unhandledRejection: ${reason}\n`);
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new StructuredLogger(process.env.LOG_LEVEL ?? 'info'),
    bufferLogs: false,
  });

  // Route all Nest logging through the DI-managed structured logger.
  app.useLogger(app.get(StructuredLogger));

  // Signed contracts carry a drawn-signature image as a base64 data URL, which
  // can exceed Express's default 100kb JSON body limit — raise it so those
  // writes aren't rejected with 413.
  app.useBodyParser('json', { limit: '6mb' });

  // Serve the admin UI (static SPA) from /public. API controllers are mounted
  // at their own paths (/creators, /roster, /contracts, …); express.static only
  // responds when a file actually matches, so it never shadows an API route.
  // `index.html` is served for `/`.
  app.useStaticAssets(join(__dirname, '..', 'public'), { index: ['index.html'] });

  const config = app.get(ConfigService);

  // Global input validation: strip unknown props, coerce query strings to the
  // DTO types, and reject payloads with extra fields.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableCors();
  app.enableShutdownHooks();

  const port = config.get<number>('server.port') ?? 3000;

  // Bind to all interfaces so the platform proxy/healthcheck can reach us.
  // Defaults to 0.0.0.0 (IPv4, current behavior). Railway's private network is
  // IPv6-only, so set HOST=:: in the unified project to also receive
  // service-to-service calls over *.railway.internal (e.g. outreach -> this
  // service). The explicit stdout line makes the bound host/port unmissable in
  // deploy logs.
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
  process.stdout.write(`[startup] HTTP server listening on ${host}:${port}\n`);

  const logger = app.get(StructuredLogger);
  logger.event('info', 'server.started', {
    port,
    nodeEnv: config.get<string>('server.nodeEnv'),
    railwayEnvironment: config.get<string>('server.railwayEnvironment'),
    schedulerEnabled: config.get<boolean>('jobs.enableScheduler'),
  });

  // Apply pending migrations AFTER the server is already listening, so the
  // platform healthcheck can never be blocked by the migration step. On a
  // normal deploy there are no pending migrations and this returns in a second;
  // on a deploy that ships schema changes they apply moments after boot. Set
  // RUN_MIGRATIONS_ON_BOOT=false to opt out (e.g. if you migrate out-of-band).
  if (config.get<string>('server.nodeEnv') !== 'test') {
    runPendingMigrations();
  }
}

/**
 * Fire-and-forget `prisma migrate deploy` in a child process. Deliberately not
 * awaited: the HTTP server is already up, so migrations run in the background
 * and log their own result. Uses the Prisma CLI shipped in node_modules (a
 * production dependency) rather than `npx`, so there is never a runtime
 * download that could stall startup.
 */
function runPendingMigrations(): void {
  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'false') {
    process.stdout.write('[startup] RUN_MIGRATIONS_ON_BOOT=false — skipping migrate deploy\n');
    return;
  }

  const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(prismaCli)) {
    process.stderr.write(
      `[startup] prisma CLI not found at ${prismaCli}; skipping automatic migrate deploy\n`,
    );
    return;
  }

  process.stdout.write('[startup] running prisma migrate deploy in background…\n');
  const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code === 0) {
      process.stdout.write('[startup] prisma migrate deploy completed\n');
    } else {
      process.stderr.write(`[startup] prisma migrate deploy exited with code ${code}\n`);
    }
  });
  child.on('error', (err) => {
    process.stderr.write(`[startup] failed to run prisma migrate deploy: ${err.message}\n`);
  });
}

bootstrap().catch(async (err) => {
  process.stderr.write(`[fatal] bootstrap failed: ${err?.stack ?? err}\n`);
  // Give the log shipper a moment to flush before the container is torn down.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(1);
});
