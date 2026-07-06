import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { LoggerModule } from './common/logger/logger.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { ActivityLogModule } from './modules/activity-log/activity-log.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CreatorsModule } from './modules/creators/creators.module';
import { EmailHistoryModule } from './modules/email-history/email-history.module';
import { HealthModule } from './modules/health/health.module';
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
    ActivityLogModule,
    CreatorsModule,
    CampaignsModule,
    StatisticsModule,
    EmailHistoryModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
