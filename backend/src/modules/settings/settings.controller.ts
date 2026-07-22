import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AppSettings } from './schemas/settings.schema';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('public')
  async publicSettings() {
    const settings = await this.settingsService.getSettings();
    return { storeName: settings.storeName, logoUrl: settings.logoUrl };
  }

  @Get()
  @UseGuards(JwtAuthGuard, AdminRoleGuard)
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Patch()
  @UseGuards(JwtAuthGuard, AdminRoleGuard)
  updateSettings(@Body() body: Partial<AppSettings>) {
    return this.settingsService.updateSettings(body);
  }
}
