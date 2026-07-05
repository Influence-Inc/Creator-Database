import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { StructuredLogger } from './common/logger/structured-logger.service';

async function bootstrap(): Promise<void> {
  // Bootstrap logger — replaced by the DI-configured instance below once the
  // ConfigService is available, but needed for early bootstrap messages.
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
  await app.listen(port, '0.0.0.0');

  const logger = app.get(StructuredLogger);
  logger.event('info', 'server.started', {
    port,
    nodeEnv: config.get<string>('server.nodeEnv'),
    railwayEnvironment: config.get<string>('server.railwayEnvironment'),
    schedulerEnabled: config.get<boolean>('jobs.enableScheduler'),
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
