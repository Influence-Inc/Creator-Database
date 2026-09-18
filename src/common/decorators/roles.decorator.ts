import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/** Metadata key carrying the roles allowed to reach a route. */
export const ROLES_KEY = 'allowedRoles';

/**
 * Restrict a route to specific roles.
 *
 * Access is ADMIN-only by default everywhere, so this decorator is what opens a
 * route up to scouts — e.g. `@Roles(UserRole.SCOUT, UserRole.ADMIN)` on the
 * scouting sheet endpoints. Leaving it off keeps a route admin-only, which is
 * the safe default for every existing Creator Database route.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
