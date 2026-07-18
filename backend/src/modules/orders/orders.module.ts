import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { TelegramModule } from '../telegram/telegram.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    GoogleSheetsModule,
    TelegramModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
