export class AppSettings {
  key: string;
  storeName: string;
  storePhone: string;
  storeAddress: string;
  workHours: string;
  logoUrl: string;
  telegramOrderAcceptedEnabled: boolean;
  telegramOrderStatusEnabled: boolean;
  telegramDebtReminderEnabled: boolean;
  telegramDebtPaymentEnabled: boolean;
  telegramSaleCreatedEnabled: boolean;
  telegramBotToken?: string;
  telegramBotConfigured?: boolean;
  telegramAdminIds: string[];
  requirePhoneForDebtSales: boolean;
  debtReminderAfterDays: number;
  preventSameDayDebtReminder: boolean;
  debtReminderText: string;
  googleSheetsEnabled: boolean;
  googleSheetsSpreadsheetId: string;
  googleSheetsServiceAccountEmail: string;
  googleSheetsPrivateKey: string;
  googleSheetsOrdersSheet: string;
  googleSheetsSalesSheet: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SettingsDocument = AppSettings;
