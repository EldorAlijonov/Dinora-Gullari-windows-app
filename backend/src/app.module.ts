import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LocalDatabaseModule } from './local-db/local-database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrdersModule } from './modules/orders/orders.module';
import { SalesModule } from './modules/sales/sales.module';
import { DebtsModule } from './modules/debts/debts.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SettingsModule } from './modules/settings/settings.module';
import { validateEnv } from './config/env.validation';
import { BackupsModule } from './modules/backups/backups.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { GoogleSheetsModule } from './modules/google-sheets/google-sheets.module';
import { ServiceModule } from './modules/service/service.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LocalDatabaseModule,
    ScheduleModule.forRoot(),
    AuthModule,
    UsersModule,
    OrdersModule,
    SalesModule,
    DebtsModule,
    DashboardModule,
    ReportsModule,
    TelegramModule,
    NotificationsModule,
    SettingsModule,
    GoogleSheetsModule,
    BackupsModule,
    MonitoringModule,
    // Service tools for developer maintenance
    ServiceModule,
  ],
})
export class AppModule {}
