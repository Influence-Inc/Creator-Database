// Guards the tiny but important @Transform on EditContactDto.email: an empty
// string must become null BEFORE @IsEmail runs, so a cleared email field on the
// Contact card doesn't 400 the whole save. Round-trips through the exact
// class-transformer + class-validator pipeline Nest's ValidationPipe uses
// (transform: true, whitelist: true), so this is a real behavioral guarantee
// rather than a smoke test.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('reflect-metadata'); // class-validator decorators need it at load time
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDetailsDto } from './update-details.dto';

async function loadAndValidate(payload: unknown) {
  const dto = plainToInstance(UpdateDetailsDto, payload as object, {
    enableImplicitConversion: false,
  });
  const errors = await validate(dto as object, { whitelist: true });
  return { dto: dto as UpdateDetailsDto, errors };
}

describe('EditContactDto email transform', () => {
  it('clears email: empty string is transformed to null and passes IsEmail', async () => {
    const { dto, errors } = await loadAndValidate({ contact: { email: '' } });
    expect(errors).toHaveLength(0);
    // roster.service.updateDetails uses `contact.email !== undefined` to know
    // it was sent, and treats null as "clear it" — this shape matches.
    expect(dto.contact?.email).toBeNull();
  });

  it('accepts a valid email unchanged', async () => {
    const { dto, errors } = await loadAndValidate({
      contact: { email: 'creator@example.com' },
    });
    expect(errors).toHaveLength(0);
    expect(dto.contact?.email).toBe('creator@example.com');
  });

  it('still rejects a syntactically invalid email (transform only shortcuts "")', async () => {
    const { errors } = await loadAndValidate({
      contact: { email: 'not-an-email' },
    });
    // The nested error surfaces on `contact` → children include email.
    const stringified = JSON.stringify(errors);
    expect(stringified).toMatch(/email must be a valid email address/);
  });

  it('leaves email untouched when omitted (existing value is preserved by the service)', async () => {
    const { dto, errors } = await loadAndValidate({
      contact: { phone: '+15551234' },
    });
    expect(errors).toHaveLength(0);
    expect(dto.contact?.email).toBeUndefined();
  });
});
