import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredLogger } from './structured-logger.service';

/**
 * Global logger module. Exposes the StructuredLogger for DI so services that
 * want structured `event()` logging can inject it, while plain `new Logger()`
 * usage still routes through it via the app-level logger set in main.ts.
 */
@Global()
@Module({
  providers: [
    {
      provide: StructuredLogger,
      useFactory: (config: ConfigService) =>
        new StructuredLogger(config.get<string>('server.logLevel') ?? 'info'),
      inject: [ConfigService],
    },
  ],
  exports: [StructuredLogger],
})
export class LoggerModule {}
