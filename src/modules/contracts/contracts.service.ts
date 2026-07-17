import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ActivitySource, ContractStatus, NegotiationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorUpsertInput } from '../creators/creator-fields.interface';
import { CreatorsService } from '../creators/creators.service';
import { CreateContractDto } from './dto/create-contract.dto';

/**
 * Ingests signed contracts from the Outreach backend. Each call:
 *   1. upserts the master Creator by identity (email → instagram → name), folding
 *      in the final agreed terms and flipping the deal to COMPLETED, and
 *   2. records the Contract row (idempotent on the Outreach token `contractRef`,
 *      so a re-sync updates rather than duplicates).
 *
 * Reuses CreatorsService.upsertFromSource for (1) so future campaigns keep sharing
 * one master record instead of creating duplicates.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creators: CreatorsService,
  ) {}

  private toDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  async createFromOutreach(dto: CreateContractDto) {
    if (!dto.creatorName && !dto.email && !dto.instagramUsername) {
      throw new BadRequestException(
        'At least one creator identity field is required: email, instagramUsername, or creatorName',
      );
    }

    // 1. Upsert the master creator with the final agreed terms. The signer's
    //    email/phone from the signing form fill the master record too (email is
    //    only used as an identity fill when the creator has none yet).
    const creatorInput: CreatorUpsertInput = {
      creatorName: dto.creatorName,
      email: dto.email ?? dto.signerEmail,
      instagramUsername: dto.instagramUsername,
      phoneNumber: dto.signerPhone,
      campaignName: dto.campaignName,
      acceptedRate: dto.compensation,
      currency: dto.currency,
      numberOfVideos: dto.numberOfDeliverables,
      guaranteedViews: dto.guaranteedViews,
      deadline: this.toDate(dto.deadline),
      deliverablesDescription: dto.deliverables,
      status: NegotiationStatus.COMPLETED,
    };
    const result = await this.creators.upsertFromSource(
      creatorInput,
      ActivitySource.CONTRACT_SIGNED,
    );
    if (!result.creator) {
      throw new BadRequestException('Unable to resolve or create a creator from the contract');
    }
    const creator = result.creator;

    // 2. Record the contract (idempotent on the Outreach token).
    const existing = await this.prisma.contract.findUnique({
      where: { contractRef: dto.contractRef },
    });

    const data = {
      contractUrl: dto.contractUrl,
      brandName: dto.brandName,
      campaignName: dto.campaignName,
      platform: dto.platform,
      deliverables: dto.deliverables,
      numberOfDeliverables: dto.numberOfDeliverables,
      timeline: dto.timeline,
      deadline: this.toDate(dto.deadline),
      usageRights: dto.usageRights,
      exclusivity: dto.exclusivity,
      guaranteedViews: dto.guaranteedViews,
      compensation: dto.compensation,
      currency: dto.currency,
      paymentTerms: dto.paymentTerms,
      specialNotes: dto.specialNotes,
      additionalTerms: dto.additionalTerms as Prisma.InputJsonValue | undefined,
      status: dto.status ?? ContractStatus.COMPLETED,
      signerName: dto.signerName,
      signedAt: this.toDate(dto.signedAt),
      // Signer details captured on the signing form.
      signerEmail: dto.signerEmail,
      signerPhone: dto.signerPhone,
      signerGender: dto.signerGender,
      signerSignedDate: this.toDate(dto.signerSignedDate),
      signatureImage: dto.signatureImage,
      addressLine1: dto.address?.line1,
      addressLine2: dto.address?.line2,
      addressCity: dto.address?.city,
      addressState: dto.address?.state,
      addressPostalCode: dto.address?.zip,
      addressCountry: dto.address?.country,
      paymentDetails: dto.paymentDetails
        ? (dto.paymentDetails as unknown as Prisma.InputJsonValue)
        : undefined,
    };

    const contract = await this.prisma.contract.upsert({
      where: { contractRef: dto.contractRef },
      create: { contractRef: dto.contractRef, creatorId: creator.id, ...data },
      update: data,
    });

    this.logger.log(
      `Contract ${dto.contractRef} ${existing ? 'updated' : 'created'} for creator ${creator.id}`,
    );
    return { creatorId: creator.id, contractId: contract.id, created: !existing };
  }

  /** All contracts for a creator, newest first (contract history). */
  findByCreator(creatorId: string) {
    return this.prisma.contract.findMany({
      where: { creatorId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
