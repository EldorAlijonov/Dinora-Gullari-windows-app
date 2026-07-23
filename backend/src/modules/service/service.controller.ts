import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Res, UseGuards, UploadedFile, UseInterceptors } from '@nestjs/common';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ServiceRoleGuard } from '../../common/guards/service-role.guard';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

@Controller('service')
@UseGuards(JwtAuthGuard, ServiceRoleGuard)
export class ServiceController {
  constructor(private readonly database: LocalDatabaseService, private readonly users: UsersService) {}

  @Get('info')
  info() {
    const packageJson = require('../../../package.json') as { version?: string };
    const appVersion = packageJson.version || 'unknown';
    return {
      appVersion,
      databasePath: this.database.paths.database,
      sqliteSize: this.database.sizeInBytes(),
      databaseSize: this.database.sizeInBytes(),
      buildVersion: process.env.BUILD_VERSION || appVersion,
      nodeVersion: process.version,
      electronVersion: process.versions.electron || null,
    };
  }

  @Post('customer')
  async createOrUpdateCustomer(
    @Body()
    body: { fullName?: string; username?: string; password?: string; confirmPassword?: string; email?: string; phone?: string },
  ) {
    const fullName = body.fullName?.trim();
    const username = body.username?.trim();
    const password = body.password || '';
    if (!fullName || !username || password.length < 6) {
      throw new BadRequestException('Mijoz ismi, login va kamida 6 belgili parol kiritilishi shart');
    }
    if (body.confirmPassword !== undefined && body.confirmPassword !== password) {
      throw new BadRequestException('Parollar mos emas');
    }

    const admin = this.users.findAdmin();
    const customer = await this.users.upsertAdmin({
      fullName,
      email: body.email?.trim() || admin?.email || 'admin@local',
      phone: body.phone?.trim() || admin?.phone || '+001000000000',
      password,
      username,
    });
    return { customer };
  }

  @Post('customer/reset-password')
  async resetCustomerPassword(@Body() body: { newPassword?: string }) {
    if (!body.newPassword || body.newPassword.length < 6) {
      throw new BadRequestException('Yangi parol kamida 6 ta belgidan iborat bo‘lishi kerak');
    }
    const existingAdmin = this.users.findAdmin();
    if (!existingAdmin) throw new NotFoundException('Mijoz akkaunti topilmadi');
    const updated = await this.users.resetPasswordForUserId(existingAdmin.id, body.newPassword);
    return { updated };
  }

  @Get('backup/export')
  exportDatabase(@Res() res: Response) {
    const dbPath = this.database.paths.database;
    if (!existsSync(dbPath)) {
      return res.status(404).json({ error: 'Baza topilmadi' });
    }
    const content = readFileSync(dbPath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="dinora-database.sqlite"');
    res.send(content);
  }

  @Post('backup/import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, tmpdir());
        },
        filename: (_req, file, cb) => {
          cb(null, `dinora-import-${Date.now()}-${file.originalname}`);
        },
      }),
    }),
  )
  async importDatabase(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Import qilinadigan fayl tanlanmagan');
    try {
      await this.database.replaceDatabaseFromFile(file.path);
      return { imported: true };
    } finally {
      try {
        unlinkSync(file.path);
      } catch {
        // temporary cleanup best effort
      }
    }
  }
}
