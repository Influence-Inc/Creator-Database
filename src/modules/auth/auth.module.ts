import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionRefreshMiddleware } from './session-refresh.middleware';

/**
 * Global so AuthService is injectable anywhere (notably the role guards) without
 * every feature module importing AuthModule — which would otherwise create a
 * cycle, since AuthModule itself needs UsersModule to authenticate scouts.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, SessionRefreshMiddleware],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs on every route so any authenticated request can extend the cookie.
    // The middleware itself no-ops when auth isn't enforced or the cookie
    // isn't valid, so it's cheap to leave global.
    consumer.apply(SessionRefreshMiddleware).forRoutes('*');
  }
}
