import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as exempt from the auth guards. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or controller) as public — the global ApiKeyGuard and
 * ReadAccessGuard both skip it. Used for the health check and the auth
 * endpoints (which must be reachable before a session exists).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
