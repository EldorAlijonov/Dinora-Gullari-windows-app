import { Global, Module } from '@nestjs/common';
import { LocalDatabaseService } from './local-database.service';

@Global()
@Module({
  providers: [LocalDatabaseService],
  exports: [LocalDatabaseService],
})
export class LocalDatabaseModule {}
