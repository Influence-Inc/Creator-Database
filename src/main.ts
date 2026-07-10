import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger(process.env.LOG_LEVEL ?? 'info'),
    bufferLogs: false,
  });

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

  // Bind to all interfaces so the platform proxy/healthcheck can reach us.
  // The explicit stdout line makes the bound port unmissable in deploy logs.
  await app.listen(port, '0.0.0.0');
  process.stdout.write(`[startup] HTTP server listening on 0.0.0.0:${port}\n`);

  const logger = app.get(StructuredLogger);
  logger.event('info', 'server.started', {
    port,
    nodeEnv: config.get<string>('server.nodeEnv'),
    railwayEnvironment: config.get<string>('server.railwayEnvironment'),
    schedulerEnabled: config.get<boolean>('jobs.enableScheduler'),
  });
}

bootstrap().catch(async (err) => {
  process.stderr.write(`[fatal] bootstrap failed: ${err?.stack ?? err}\n`);
  // Give the log shipper a moment to flush before the container is torn down.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  process.exit(1);
});
