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
  console.error(message);
  process.exit(1);
});
