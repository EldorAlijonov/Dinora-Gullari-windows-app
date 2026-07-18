import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SettingsModule } from '../settings/settings.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [
    GoogleSheetsModule,
    TelegramModule,
    SettingsModule,
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
