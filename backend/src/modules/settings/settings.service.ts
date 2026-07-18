import { Injectable } from '@nestjs/common';
import { normalizeGooglePrivateKey } from '../../common/google-private-key';
import { sanitizeImageUrl } from '../../common/image-url';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { AppSettings } from './schemas/settings.schema';

const SETTINGS_KEY = 'global';

type LocalSettingsRow = Omit<AppSettings, 'telegramAdminIds'> & {
  key: string;
  telegramAdminIds: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class SettingsService {
  constructor(private readonly database: LocalDatabaseService) {}

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
    return {
      ...row,
      telegramOrderAcceptedEnabled: Boolean(row.telegramOrderAcceptedEnabled),
      telegramOrderStatusEnabled: Boolean(row.telegramOrderStatusEnabled),
      telegramDebtReminderEnabled: Boolean(row.telegramDebtReminderEnabled),
      telegramDebtPaymentEnabled: Boolean(row.telegramDebtPaymentEnabled),
      telegramSaleCreatedEnabled: Boolean(row.telegramSaleCreatedEnabled),
      requirePhoneForDebtSales: Boolean(row.requirePhoneForDebtSales),
      preventSameDayDebtReminder: Boolean(row.preventSameDayDebtReminder),
      googleSheetsEnabled: Boolean(row.googleSheetsEnabled),
      telegramAdminIds: this.parseTelegramAdminIds(row.telegramAdminIds),
    };
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
