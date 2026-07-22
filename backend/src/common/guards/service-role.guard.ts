import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class ServiceRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user || user.role !== 'service') {
      throw new ForbiddenException('Access denied');
    }
    return true;
  }
}
