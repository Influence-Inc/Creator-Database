import { NotFoundException } from '@nestjs/common';
import { Contract, Creator } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContractDocumentService } from './contract-document.service';

// A representative signed contract with EVERY sensitive payout field populated,
// so the "no bank details" guarantee is tested against real-looking values.
const BANK = {
  accountHolderName: 'Alex Rivera',
  bankName: 'First National Bank',
  accountNumber: '000123456789',
  iban: 'GB33BUKB20201555555555',
  routingNumber: '021000021',
  ifscCode: 'HDFC0001234',
  swiftCode: 'BUKBGB22',
  panNumber: 'ABCDE1234F',
  taxIdNumber: 'TAX-99-8877',
};

function buildContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'k1',
    contractRef: 'tok-abc-123',
    contractUrl: 'https://sign.example.com/tok-abc-123',
    creatorId: 'c1',
    brandName: 'Acme Beverages',
    campaignName: 'Summer Splash',
    platform: 'Instagram',
    deliverables: '2 Reels and 3 Stories',
    numberOfDeliverables: 5,
    timeline: 'content approved by June 20, posted by July 1',
    deadline: new Date('2026-07-30T00:00:00.000Z'),
    usageRights: 'Organic use on the Brand handles for 6 months.',
    exclusivity: 'No competing beverage brands for 30 days.',
    guaranteedViews: 250000,
    compensation: 4200,
    currency: 'USD',
    paymentTerms: 'net 30 after approval',
    specialNotes: 'Creator to attend the launch event on July 5.',
    additionalTerms: ['Whitelisting available on request.', 'Two rounds of revisions included.'],
    status: 'COMPLETED',
    signerName: 'Alex Rivera',
    signerEmail: 'alex@example.com',
    signerPhone: '+1 555 010 2020',
    signerGender: 'female',
    signerSignedDate: new Date('2026-06-15T00:00:00.000Z'),
    signatureImage:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m\nNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    signedAt: new Date('2026-06-15T12:00:00.000Z'),
    addressLine1: '742 Evergreen Terrace',
    addressLine2: 'Apt 3',
    addressCity: 'Springfield',
    addressState: 'IL',
    addressPostalCode: '62704',
    addressCountry: 'USA',
    paymentDetails: BANK as unknown as Contract['paymentDetails'],
    createdAt: new Date('2026-06-15T12:00:00.000Z'),
    updatedAt: new Date('2026-06-15T12:00:00.000Z'),
    ...overrides,
  } as Contract;
}

function buildCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    id: 'c1',
    creatorName: 'Alex Rivera',
    instagramUsername: 'alexcreates',
    email: 'alex@example.com',
    phoneNumber: '+1 555 010 2020',
    addressLine1: '742 Evergreen Terrace',
    addressCity: 'Springfield',
    addressCountry: 'USA',
    ...overrides,
  } as unknown as Creator;
}

function makeService(creator: Creator | null, contract: Contract | null) {
  const prisma = {
    creator: { findUnique: jest.fn(async () => creator) },
    contract: { findFirst: jest.fn(async () => contract) },
  } as unknown as PrismaService;
  return { svc: new ContractDocumentService(prisma), prisma };
}

describe('ContractDocumentService', () => {
  it('renders a legal Creator Content Agreement with the key contract terms', async () => {
    const { svc } = makeService(buildCreator(), buildContract());
    const { html } = await svc.render('c1', 'k1');

    expect(html).toContain('Creator Content Agreement');
    expect(html).toContain('Acme Beverages');
    expect(html).toContain('Summer Splash');
    expect(html).toContain('2 Reels and 3 Stories');
    expect(html).toContain('Instagram');
    expect(html).toContain('No competing beverage brands for 30 days.');
    expect(html).toContain('250,000'); // guaranteed views, formatted
    expect(html).toContain('$4,200.00 USD'); // compensation, formatted
    // Signer / party identity + address are legitimate contract details.
    expect(html).toContain('Alex Rivera');
    expect(html).toContain('alex@example.com');
    expect(html).toContain('742 Evergreen Terrace');
    // Optional special provisions surface.
    expect(html).toContain('Creator to attend the launch event on July 5.');
    expect(html).toContain('Whitelisting available on request.');
    // Signature image embedded → self-contained document.
    expect(html).toContain('data:image/png;base64,');
  });

  it('NEVER includes the creator bank / payout details', async () => {
    const { svc } = makeService(buildCreator(), buildContract());
    const { html } = await svc.render('c1', 'k1');

    for (const secret of Object.values(BANK)) {
      // The account holder name legitimately doubles as the signer name, so skip
      // that one — every genuinely-sensitive banking value must be absent.
      if (secret === BANK.accountHolderName) continue;
      expect(html).not.toContain(secret);
    }
    // And it states, in the compensation clause, that banking is held separately.
    expect(html).toContain('does not form part of this Agreement');
  });

  it('escapes creator-supplied content to prevent script injection', async () => {
    const { svc } = makeService(
      buildCreator(),
      buildContract({
        deliverables: '<script>alert(1)</script>',
        specialNotes: '<img src=x onerror=alert(2)>',
      }),
    );
    const { html } = await svc.render('c1', 'k1');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('drops a signature image that is not a valid data URL', async () => {
    const { svc } = makeService(
      buildCreator(),
      buildContract({ signatureImage: 'javascript:alert(1)' }),
    );
    const { html } = await svc.render('c1', 'k1');
    expect(html).not.toContain('javascript:alert(1)');
  });

  it('produces a safe, descriptive download filename', async () => {
    const { svc } = makeService(buildCreator(), buildContract());
    const { filename } = await svc.render('c1', 'k1');
    expect(filename).toMatch(/^Creator-Content-Agreement-.*\.html$/);
    expect(filename).not.toMatch(/[^A-Za-z0-9._-]/); // no unsafe chars
  });

  it('still renders with sparse data (fallback legal language, no crash)', async () => {
    const sparse = buildContract({
      brandName: null,
      campaignName: null,
      deliverables: null,
      numberOfDeliverables: null,
      platform: null,
      timeline: null,
      deadline: null,
      usageRights: null,
      exclusivity: null,
      guaranteedViews: null,
      compensation: null,
      paymentTerms: null,
      specialNotes: null,
      additionalTerms: null,
      signatureImage: null,
    });
    const { svc } = makeService(buildCreator(), sparse);
    const { html } = await svc.render('c1', 'k1');
    expect(html).toContain('Creator Content Agreement');
    expect(html).toContain('campaign brief'); // deliverables fallback text
  });

  it('throws NotFound for a missing creator', async () => {
    const { svc } = makeService(null, buildContract());
    await expect(svc.render('missing', 'k1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound when the contract does not belong to the creator', async () => {
    const { svc } = makeService(buildCreator(), null);
    await expect(svc.render('c1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes the contract lookup to the creator id', async () => {
    const { svc, prisma } = makeService(buildCreator(), buildContract());
    await svc.render('c1', 'k1');
    expect(prisma.contract.findFirst as jest.Mock).toHaveBeenCalledWith({
      where: { id: 'k1', creatorId: 'c1' },
    });
  });
});
