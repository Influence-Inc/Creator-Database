import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class MergeCreatorsDto {
  /** The record to keep — normally the master holding the Instagram handle. */
  @IsUUID()
  survivorId!: string;

  /** The record to fold in and delete. */
  @IsUUID()
  duplicateId!: string;

  /** Preview the merge without writing. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
