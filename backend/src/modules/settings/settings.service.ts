import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeGooglePrivateKey } from '../../common/google-private-key';
import { sanitizeImageUrl } from '../../common/image-url';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { AppSettings } from './schemas/settings.schema';

const SETTINGS_KEY = 'global';
type SettingsListener = () => void | Promise<void>;

type LocalSettingsRow = Omit<AppSettings, 'telegramAdminIds' | 'telegramBotConfigured'> & {
  key: string;
  telegramBotToken: string;
  telegramAdminIds: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly telegramSettingsListeners = new Set<SettingsListener>();

  constructor(
    private readonly database: LocalDatabaseService,
    private readonly config: ConfigService,
  ) {}

  onTelegramSettingsChanged(listener: SettingsListener) {
    this.telegramSettingsListeners.add(listener);
    return () => this.telegramSettingsListeners.delete(listener);
  }

  async getSettings() {
    this.ensureSettings();
    const row = this.database.get<LocalSettingsRow>('SELECT * FROM settings WHERE key = ? LIMIT 1', [SETTINGS_KEY]);
    return this.mapSettings(row!);
  }

  async updateSettings(body: Partial<AppSettings>) {
    this.ensureSettings();
    const allowed: Partial<AppSettings> = {
      storeName: body.storeName,
      storePhone: body.storePhone,
      storeAddress: body.storeAddress,
      workHours: body.workHours,
      logoUrl: sanitizeImageUrl(body.logoUrl, 'Dokon logosi'),
      telegramOrderAcceptedEnabled: body.telegramOrderAcceptedEnabled,
      telegramOrderStatusEnabled: body.telegramOrderStatusEnabled,
      telegramDebtReminderEnabled: body.telegramDebtReminderEnabled,
      telegramDebtPaymentEnabled: body.telegramDebtPaymentEnabled,
      telegramSaleCreatedEnabled: body.telegramSaleCreatedEnabled,
      telegramBotToken: body.telegramBotToken === undefined ? undefined : String(body.telegramBotToken || '').trim(),
      telegramAdminIds: Array.isArray(body.telegramAdminIds) ? this.cleanTelegramAdminIds(body.telegramAdminIds) : undefined,
      requirePhoneForDebtSales: body.requirePhoneForDebtSales,
      debtReminderAfterDays: body.debtReminderAfterDays,
      preventSameDayDebtReminder: body.preventSameDayDebtReminder,
      debtReminderText: body.debtReminderText,
      googleSheetsEnabled: body.googleSheetsEnabled,
      googleSheetsSpreadsheetId: body.googleSheetsSpreadsheetId,
      googleSheetsServiceAccountEmail: body.googleSheetsServiceAccountEmail,
      googleSheetsPrivateKey: body.googleSheetsPrivateKey === undefined ? undefined : normalizeGooglePrivateKey(body.googleSheetsPrivateKey),
      googleSheetsOrdersSheet: body.googleSheetsOrdersSheet,
      googleSheetsSalesSheet: body.googleSheetsSalesSheet,
    };

    const entries = Object.entries(allowed).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
      const values = entries.map(([key, value]) => {
        if (key === 'telegramAdminIds') return JSON.stringify(value || []);
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value as string | number | null;
      });
      this.database.run(`UPDATE settings SET ${assignments}, updatedAt = ? WHERE key = ?`, [
        ...values,
        new Date().toISOString(),
        SETTINGS_KEY,
      ]);
      this.notifyTelegramSettingsChanged();
    }

    return this.getSettings();
  }

  async getStoreName() {
    const settings = await this.getSettings();
    return settings?.storeName || 'Dinora Gullari';
  }

  async getTelegramAdminIds() {
    const settings = await this.getSettings();
    return this.cleanTelegramAdminIds(settings?.telegramAdminIds || []);
  }

  async getTelegramBotToken() {
    this.ensureSettings();
    const row = this.database.get<{ telegramBotToken: string }>('SELECT telegramBotToken FROM settings WHERE key = ? LIMIT 1', [SETTINGS_KEY]);
    return String(row?.telegramBotToken || this.config.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
  }

  async addTelegramAdminId(chatId: string) {
    const cleaned = this.cleanTelegramAdminIds([chatId])[0];
    if (!cleaned) return this.getSettings();
    const current = await this.getTelegramAdminIds();
    return this.updateSettings({ telegramAdminIds: [...new Set([...current, cleaned])] } as Partial<AppSettings>);
  }

  async removeTelegramAdminId(chatId: string) {
    const cleaned = this.cleanTelegramAdminIds([chatId])[0];
    if (!cleaned) return this.getSettings();
    const current = await this.getTelegramAdminIds();
    return this.updateSettings({ telegramAdminIds: current.filter((id) => id !== cleaned) } as Partial<AppSettings>);
  }

  private ensureSettings() {
    const now = new Date().toISOString();
    this.database.run(`INSERT OR IGNORE INTO settings (key, createdAt, updatedAt) VALUES (?, ?, ?)`, [SETTINGS_KEY, now, now]);
  }

  private mapSettings(row: LocalSettingsRow) {
    const { telegramBotToken, ...safeRow } = row;
    return {
      ...safeRow,
      telegramOrderAcceptedEnabled: Boolean(row.telegramOrderAcceptedEnabled),
      telegramOrderStatusEnabled: Boolean(row.telegramOrderStatusEnabled),
      telegramDebtReminderEnabled: Boolean(row.telegramDebtReminderEnabled),
      telegramDebtPaymentEnabled: Boolean(row.telegramDebtPaymentEnabled),
      telegramSaleCreatedEnabled: Boolean(row.telegramSaleCreatedEnabled),
      telegramBotConfigured: Boolean(telegramBotToken || this.config.get<string>('TELEGRAM_BOT_TOKEN')),
      requirePhoneForDebtSales: Boolean(row.requirePhoneForDebtSales),
      preventSameDayDebtReminder: Boolean(row.preventSameDayDebtReminder),
      googleSheetsEnabled: Boolean(row.googleSheetsEnabled),
      telegramAdminIds: this.parseTelegramAdminIds(row.telegramAdminIds),
    };
  }

  private notifyTelegramSettingsChanged() {
    for (const listener of this.telegramSettingsListeners) {
      Promise.resolve(listener()).catch((error) => {
        this.logger.warn(`Telegram settings listener failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private parseTelegramAdminIds(value: string) {
    try {
      return this.cleanTelegramAdminIds(JSON.parse(value));
    } catch {
      return [];
    }
  }

  private cleanTelegramAdminIds(values: string[]) {
    return [...new Set(values.map((value) => String(value || '').trim()).filter((value) => /^-?\d+$/.test(value)))];
  }
}
