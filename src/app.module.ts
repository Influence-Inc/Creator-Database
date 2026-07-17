import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { ReadAccessGuard } from './common/guards/read-access.guard';
import { LoggerModule } from './common/logger/logger.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { ActivityLogModule } from './modules/activity-log/activity-log.module';
import { AuthModule } from './modules/auth/auth.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CreatorsModule } from './modules/creators/creators.module';
import { CreatorStatsModule } from './modules/creator-stats/creator-stats.module';
import { EmailHistoryModule } from './modules/email-history/email-history.module';
import { HealthModule } from './modules/health/health.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { RosterModule } from './modules/roster/roster.module';
import { StatisticsModule } from './modules/statistics/statistics.module';
import { SyncModule } from './modules/sync/sync.module';

/**
 * Root module. Global infrastructure (config, logging, Prisma, scheduling) is
 * wired here; each feature lives in its own module under `modules/`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    LoggerModule,
    PrismaModule,

    // Feature modules
    AuthModule,
    ActivityLogModule,
    CreatorsModule,
    CreatorStatsModule,
    CampaignsModule,
    ContractsModule,
    StatisticsModule,
    EmailHistoryModule,
    SyncModule,
    RosterModule,
    MaintenanceModule,
    HealthModule,
  ],
  providers: [
    // Global x-api-key guard on mutating requests.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    // Global read guard: reads require an admin session or the x-api-key once
    // ADMIN_PASSWORD is configured (health + /auth are @Public).
    { provide: APP_GUARD, useClass: ReadAccessGuard },
  ],
})
export class AppModule {}
