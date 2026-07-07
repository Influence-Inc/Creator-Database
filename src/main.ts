import 'reflect-metadata';

// --- TEMPORARY BOOT DIAGNOSTICS -------------------------------------------
// Raw, unbuffered checkpoints bypassing our own logger, so we can see exactly
// how far startup gets even if the process is later killed before its normal
// log output would flush. Safe to remove once the Railway boot issue is
// resolved.
process.stdout.write('[BOOT 1/8] reflect-metadata loaded\n');

// Catch anything that would otherwise crash the process silently (e.g. a
// throw during module-level evaluation of an imported file, which happens
// before bootstrap()'s own try/catch is even reachable).
process.on('uncaughtException', (err) => {
  process.stderr.write(`[BOOT FATAL] uncaughtException: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[BOOT FATAL] unhandledRejection: ${reason}\n`);
});

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
process.stdout.write('[BOOT 2/8] @nestjs/common,config,core imported\n');

import { AppModule } from './app.module';
process.stdout.write('[BOOT 3/8] AppModule imported (all providers resolved at module-load time)\n');

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { StructuredLogger } from './common/logger/structured-logger.service';
process.stdout.write('[BOOT 4/8] remaining imports loaded\n');

async function bootstrap(): Promise<void> {
  process.stdout.write('[BOOT 5/8] entered bootstrap(), about to call NestFactory.create\n');

  // Bootstrap logger — replaced by the DI-configured instance below once the
  // ConfigService is available, but needed for early bootstrap messages.
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger(process.env.LOG_LEVEL ?? 'info'),
    bufferLogs: false,
  });
  process.stdout.write('[BOOT 6/8] NestFactory.create resolved — Nest app instance created\n');

  // Route all Nest logging through the DI-managed structured logger.
  app.useLogger(app.get(StructuredLogger));

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
  process.stdout.write(`[BOOT 7/8] about to call app.listen(${port}, '0.0.0.0')\n`);
  await app.listen(port, '0.0.0.0');
  process.stdout.write('[BOOT 8/8] app.listen resolved — server is listening\n');

  const logger = app.get(StructuredLogger);
  logger.event('info', 'server.started', {
    port,
    nodeEnv: config.get<string>('server.nodeEnv'),
    railwayEnvironment: config.get<string>('server.railwayEnvironment'),
    schedulerEnabled: config.get<boolean>('jobs.enableScheduler'),
  });
}

bootstrap().catch(async (err) => {
  process.stderr.write(`[BOOT FATAL] bootstrap() rejected: ${err?.stack ?? err}\n`);
  // Give the log shipper time to flush before the container is torn down —
  // a process that exits within milliseconds of writing to stderr can have
  // its final lines dropped by some log pipelines.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  process.exit(1);
});
