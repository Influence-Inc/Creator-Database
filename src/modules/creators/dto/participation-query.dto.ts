import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /creators/participation` — the Outreach Deal Studio's new-vs-old
 * segmentation lookup. Given a batch of Instagram handles (the creators used in a
 * campaign) and the name of that current campaign, the response reports which of
 * them have already participated in a *different* campaign.
 */
export class ParticipationQueryDto {
  /** Instagram handles/URLs to look up (normalized server-side). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  instagramUsernames!: string[];

  /**
   * The current campaign's name. Participation in a campaign whose name matches
   * this (case-insensitive) does NOT count as "prior" — only participation in a
   * different campaign makes a creator "old". Omit to treat any recorded
   * participation as prior.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  excludeCampaign?: string;
}
