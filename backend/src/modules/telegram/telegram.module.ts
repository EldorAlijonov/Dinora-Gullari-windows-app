import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { TelegramService } from './telegram.service';
import { TelegramUpdateService } from './telegram-update.service';

@Module({
  imports: [
    NotificationsModule,
    SettingsModule,
  ],
  providers: [TelegramService, TelegramUpdateService],
  exports: [TelegramService],
})
export class TelegramModule {}
