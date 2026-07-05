/**
 * End-to-end smoke test for the HTTP layer.
 *
 * Boots the real AppModule (global pipes, filters, routing) but overrides
 * PrismaService and the sync services with lightweight stubs so the test needs
 * neither a database nor live Instantly/Claude credentials. It verifies the
 * health endpoint, statistics endpoint, validation behaviour, and 404 handling.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/test';
process.env.ENABLE_SCHEDULER = 'false';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { AllExceptionsFilter } from 'src/common/filters/all-exceptions.filter';
import { PrismaService } from 'src/common/prisma/prisma.service';
import { StatisticsService } from 'src/modules/statistics/statistics.service';

describe('Creator Database API (e2e)', () => {
  let app: INestApplication;

  const prismaStub = {
    isHealthy: jest.fn().mockResolvedValue(true),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const statisticsStub = {
    getStatistics: jest.fn().mockResolvedValue({
      totalCreators: 0,
      byStatus: { PENDING: 0, NEGOTIATING: 0, ACCEPTED: 0, REJECTED: 0, COMPLETED: 0 },
      negotiating: 0,
      accepted: 0,
      completed: 0,
      pending: 0,
      rejected: 0,
      averageCpm: null,
      averageAcceptedRate: null,
      averageGuaranteedViews: null,
      campaignCount: 0,
      upcomingDeadlines: 0,
      pendingDeliverables: 0,
      generatedAt: new Date().toISOString(),
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(StatisticsService)
      .useValue(statisticsStub)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health returns ok when the database is reachable', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
  });

  it('GET /statistics returns the aggregate shape', async () => {
    const res = await request(app.getHttpServer()).get('/statistics').expect(200);
    expect(res.body).toHaveProperty('totalCreators', 0);
    expect(res.body).toHaveProperty('byStatus');
    expect(res.body).toHaveProperty('campaignCount', 0);
  });

  it('GET /creators rejects an invalid sort field (validation)', async () => {
    await request(app.getHttpServer()).get('/creators?sortBy=hacker').expect(400);
  });

  it('returns 404 for unknown routes', async () => {
    await request(app.getHttpServer()).get('/does-not-exist').expect(404);
  });
});
