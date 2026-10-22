import { isDeployed, secretEquals } from './security';

describe('isDeployed', () => {
  it('is false for a plain local environment', () => {
    expect(isDeployed({ NODE_ENV: 'development' })).toBe(false);
    expect(isDeployed({ NODE_ENV: 'test' })).toBe(false);
  });

  it('is true on Railway or with NODE_ENV=production', () => {
    expect(isDeployed({ RAILWAY_ENVIRONMENT: 'production' })).toBe(true);
    expect(isDeployed({ RAILWAY_ENVIRONMENT_NAME: 'staging' })).toBe(true);
    expect(isDeployed({ RAILWAY_PROJECT_ID: 'abc' })).toBe(true);
    expect(isDeployed({ NODE_ENV: 'production' })).toBe(true);
  });
});

describe('secretEquals', () => {
  it('matches only the exact secret', () => {
    expect(secretEquals('s3cret', 's3cret')).toBe(true);
    expect(secretEquals('s3cre', 's3cret')).toBe(false);
    expect(secretEquals('s3cret!', 's3cret')).toBe(false);
  });

  it('never matches when either side is missing', () => {
    expect(secretEquals(undefined, 's3cret')).toBe(false);
    expect(secretEquals('', '')).toBe(false);
    expect(secretEquals('x', '')).toBe(false);
    expect(secretEquals(['s3cret'], 's3cret')).toBe(false);
  });
});
