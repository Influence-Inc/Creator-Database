import { CreateCreatorDto } from './create-creator.dto';

/**
 * Payload for `PATCH /creator/:id`. Structurally identical to the create DTO
 * (all fields optional), but semantically an update targeting a known record.
 */
export class UpdateCreatorDto extends CreateCreatorDto {}
