import { Controller, Get, Header, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BackupsService } from './backups.service';

@Controller('backups')
@UseGuards(JwtAuthGuard)
export class BackupsController {
  constructor(private readonly backupsService: BackupsService) {}

  @Get('export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async exportJson(@Res() response: Response) {
    const payload = await this.backupsService.createExportPayload();
    const filename = `dinora-export-${new Date().toISOString().slice(0, 10)}.json`;
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.send(JSON.stringify(payload, null, 2));
  }

  @Post('create')
  createBackup() {
    return this.backupsService.createBackupFile();
  }

  @Get('files')
  findBackups() {
    return this.backupsService.listBackupFiles();
  }

  @Get('deleted-records')
  findDeletedRecords() {
    return this.backupsService.findDeletedRecords();
  }
}
