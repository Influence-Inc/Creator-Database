import { JobType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeadLetterService, MAX_ERROR_CHARS } from './dead-letter.service';

function makePrisma(existing: { id: string } | null) {
  const failedJob = {
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };
  return { failedJob, client: { failedJob } as unknown as PrismaService };
}

describe('DeadLetterService.record', () => {
  const payload = { messageId: 'm1', threadId: 't1' };

  it('inserts the first failure of an item', async () => {
    const { failedJob, client } = makePrisma(null);
    await new DeadLetterService(client).record(JobType.EMAIL_SYNC, payload, new Error('boom'));

    expect(failedJob.findFirst).toHaveBeenCalledWith({
      where: { jobType: JobType.EMAIL_SYNC, resolved: false, payload: { equals: payload } },
      select: { id: true },
    });
    expect(failedJob.create).toHaveBeenCalledTimes(1);
    expect(failedJob.update).not.toHaveBeenCalled();
  });

  it('bumps attempts on a repeat failure instead of inserting another row', async () => {
    const { failedJob, client } = makePrisma({ id: 'fj1' });
    await new DeadLetterService(client).record(JobType.EMAIL_SYNC, payload, new Error('boom'));

    expect(failedJob.create).not.toHaveBeenCalled();
    expect(failedJob.update).toHaveBeenCalledWith({
      where: { id: 'fj1' },
      data: { error: expect.stringContaining('boom'), attempts: { increment: 1 } },
    });
  });

  it('caps the stored error text', async () => {
    const { failedJob, client } = makePrisma(null);
    await new DeadLetterService(client).record(JobType.EMAIL_SYNC, payload, 'x'.repeat(50_000));

    const stored = failedJob.create.mock.calls[0][0].data.error as string;
    expect(stored.length).toBeLessThanOrEqual(MAX_ERROR_CHARS + 1);
  });

  it('never throws when the database write fails', async () => {
    const { failedJob, client } = makePrisma(null);
    failedJob.create.mockRejectedValue(new Error('No space left on device'));
    await expect(
      new DeadLetterService(client).record(JobType.EMAIL_SYNC, payload, new Error('boom')),
    ).resolves.toBeUndefined();
  });
});
