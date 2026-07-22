import { Module } from '@nestjs/common';
import { ServiceController } from './service.controller';
import { LocalDatabaseModule } from '../../local-db/local-database.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [LocalDatabaseModule, UsersModule],
  controllers: [ServiceController],
})
export class ServiceModule {}
