import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { hashPassword, verifyPassword } from '../../common/utils/password';

/** A user as returned by the API — never includes the password hash. */
export interface SafeUser {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** Instagram handle inbound DMs are matched against. */
  instagramHandle: string | null;
  /** True once we've seen a message from them and cached their Instagram id. */
  instagramLinked: boolean;
  entryCount?: number;
}

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const IG_HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const MIN_PASSWORD_LENGTH = 8;

/** Strip the password hash before a user ever leaves the service. */
function toSafe(user: User & { _count?: { scoutEntries: number } }): SafeUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    instagramHandle: user.instagramHandle,
    instagramLinked: !!user.instagramUserId,
    ...(user._count ? { entryCount: user._count.scoutEntries } : {}),
  };
}

/**
 * Account management for scouts (and any future DB-backed admins).
 *
 * The env bootstrap admin (ADMIN_USERNAME/ADMIN_PASSWORD) deliberately has no
 * row here — it stays available even if the table is empty, so an operator can
 * always get in and create the first scout.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  private normalizeUsername(raw: string): string {
    const username = String(raw ?? '')
      .trim()
      .toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new BadRequestException(
        'Username must be 3-40 characters, using lowercase letters, numbers, dot, underscore or hyphen',
      );
    }
    return username;
  }

  /**
   * Accept an Instagram handle however it's pasted — bare, with an @, or as a
   * full profile URL — and store the bare lowercase handle, which is what Meta
   * reports for a message sender. Empty clears the link.
   */
  private normalizeHandle(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    let handle = String(raw).trim();
    if (!handle) return null;

    const url = handle.match(/instagram\.com\/([^/?#\s]+)/i);
    if (url) handle = url[1];
    handle = handle.replace(/^@/, '').toLowerCase();

    if (!IG_HANDLE_RE.test(handle)) {
      throw new BadRequestException(
        'Instagram handle must be 1-30 characters: letters, numbers, dots or underscores',
      );
    }
    return handle;
  }

  private assertPasswordStrength(password: string): void {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  /** All accounts, newest first, with how many rows each scout has logged. */
  async list(role?: UserRole): Promise<SafeUser[]> {
    const users = await this.prisma.user.findMany({
      where: role ? { role } : undefined,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { scoutEntries: true } } },
    });
    return users.map(toSafe);
  }

  async findById(id: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { scoutEntries: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return toSafe(user);
  }

  async create(input: {
    username: string;
    password: string;
    displayName?: string;
    role?: UserRole;
    instagramHandle?: string;
  }): Promise<SafeUser> {
    const username = this.normalizeUsername(input.username);
    this.assertPasswordStrength(input.password);
    const instagramHandle = this.normalizeHandle(input.instagramHandle);

    try {
      const user = await this.prisma.user.create({
        data: {
          username,
          passwordHash: hashPassword(input.password),
          displayName: input.displayName?.trim() || null,
          role: input.role ?? UserRole.SCOUT,
          instagramHandle,
        },
      });
      this.logger.log(`Created ${user.role} account "${user.username}"`);
      return toSafe(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Username "${username}" is already taken`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: {
      displayName?: string | null;
      isActive?: boolean;
      password?: string;
      instagramHandle?: string | null;
    },
  ): Promise<SafeUser> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');

    const data: Prisma.UserUpdateInput = {};
    if (input.displayName !== undefined) {
      data.displayName = input.displayName?.trim() || null;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.password !== undefined) {
      this.assertPasswordStrength(input.password);
      data.passwordHash = hashPassword(input.password);
    }
    if (input.instagramHandle !== undefined) {
      const handle = this.normalizeHandle(input.instagramHandle);
      data.instagramHandle = handle;
      // Re-linking to a different handle invalidates the cached Instagram id,
      // otherwise the old account would keep writing to this scout's sheet.
      if (handle !== existing.instagramHandle) data.instagramUserId = null;
    }

    try {
      const user = await this.prisma.user.update({ where: { id }, data });
      return toSafe(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That Instagram handle is already linked to another scout');
      }
      throw err;
    }
  }

  /** Delete an account. Their scouting rows cascade away with them. */
  async remove(id: string): Promise<{ deleted: true }> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');
    await this.prisma.user.delete({ where: { id } });
    this.logger.warn(`Deleted account "${existing.username}" and all of their scouting rows`);
    return { deleted: true };
  }

  /**
   * Verify a username/password against the users table. Returns the account on
   * success, or null when the user is unknown, deactivated, or the password is
   * wrong (deliberately indistinguishable to the caller).
   */
  async validateLogin(username: string, password: string): Promise<User | null> {
    const normalized = String(username ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;

    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (!user || !user.isActive) return null;
    if (!verifyPassword(password ?? '', user.passwordHash)) return null;
    return user;
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }
}
