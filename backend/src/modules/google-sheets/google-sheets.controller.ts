import { Controller, Post, UseGuards } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/guards/admin-role.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GoogleSheetsService } from './google-sheets.service';

@Controller('google-sheets')
@UseGuards(JwtAuthGuard, AdminRoleGuard)
export class GoogleSheetsController {
  constructor(private readonly googleSheetsService: GoogleSheetsService) {}

  @Post('test')
  testConnection() {
    return this.googleSheetsService.testConnection();
  }
}
