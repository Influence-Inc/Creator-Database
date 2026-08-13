import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionRefreshMiddleware } from './session-refresh.middleware';

@Module({
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
