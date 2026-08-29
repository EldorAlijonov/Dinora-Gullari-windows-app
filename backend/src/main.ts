import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import compression = require('compression');
import { json, urlencoded } from 'express';
import rateLimit from 'express-rate-limit';
import { mkdirSync, appendFileSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { getLocalDataDir } from './local-app/paths';
import { LocalDatabaseError } from './local-db/database-errors';
import { MonitoringService } from './modules/monitoring/monitoring.service';

function parseOrigins(value?: string) {
  return (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.getHttpAdapter().getInstance().set('trust proxy', Number(config.get<string>('TRUST_PROXY') || 1));
  const bodyLimit = config.get<string>('REQUEST_BODY_LIMIT') || '10mb';
  const allowedOrigins = parseOrigins(config.get<string>('CLIENT_URLS') || config.get<string>('CLIENT_URL') || 'http://localhost:5173');
  const isHttps = config.get<string>('COOKIE_SECURE') !== 'false';

  app.use(
    helmet({
      contentSecurityPolicy: isHttps ? undefined : { directives: { upgradeInsecureRequests: null } },
      hsts: isHttps ? undefined : false,
    }),
  );
  app.use(compression());
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  app.use(
    rateLimit({
      windowMs: Number(config.get<string>('RATE_LIMIT_WINDOW_MS') || 60_000),
      max: Number(config.get<string>('RATE_LIMIT_MAX') || 180),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (config.get<string>('ELECTRON_DESKTOP') === 'true' && (!origin || origin === 'null')) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin || ''));
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter(app.get(MonitoringService)));
  const port = Number(config.get<string>('PORT') || 5000);
  await app.listen(port, '127.0.0.1');
  logDesktopBackend(`listening on 127.0.0.1:${port}`);
}

function logDesktopBackend(message: string) {
  if (process.env.ELECTRON_DESKTOP !== 'true') return;
  const dir = join(process.env.APPDATA || process.cwd(), 'dinora-gullari-windows', 'logs');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'backend-bootstrap.log'), `${new Date().toISOString()} ${message}\n`);
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  logDesktopBackend(`startup failed ${message}`);
  writeDesktopStartupError(error);
  console.error(message);
  process.exit(1);
});

function writeDesktopStartupError(error: unknown) {
  if (process.env.ELECTRON_DESKTOP !== 'true') return;
  try {
    const dir = join(getLocalDataDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    const code = error instanceof LocalDatabaseError ? error.code : 'BACKEND_START_FAILED';
    const userMessage = userFriendlyStartupMessage(code);
    appendFileSync(join(dir, 'backend-bootstrap.log'), `${new Date().toISOString()} startup error code=${code}\n`);
    require('fs').writeFileSync(
      join(dir, 'backend-startup-error.json'),
      JSON.stringify(
        {
          code,
          message: error instanceof Error ? error.message : String(error),
          userMessage,
          logPath: join(dir, 'backend.err.log'),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // Startup diagnostics are best effort; the original error still goes to stderr.
  }
}

function userFriendlyStartupMessage(code: string) {
  if (code === 'DATABASE_BACKUP_NOT_FOUND') {
    return "Ma'lumotlar bazasini ochib bo'lmadi va sog'lom zaxira nusxa topilmadi. Asl fayl saqlab qolindi. Texnik yordam uchun log fayllarini yuboring.";
  }
  if (code === 'DATABASE_MIGRATION_FAILED') {
    return "Ma'lumotlar bazasini yangilashda xatolik yuz berdi. Ma'lumotlar saqlangan, texnik yordam uchun log fayllarini yuboring.";
  }
  if (code === 'DATABASE_WRITE_FAILED') {
    return "Ma'lumotlar bazasini diskka yozishda xatolik yuz berdi. Oldingi sog'lom nusxa saqlab qolindi.";
  }
  return "Backend ishga tushmadi. Texnik yordam uchun log fayllarini yuboring.";
}
