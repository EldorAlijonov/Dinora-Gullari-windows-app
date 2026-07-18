import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');
import { escapeRegex } from '../../common/escape-regex';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatus } from '../orders/schemas/order.schema';
import { SettingsService } from '../settings/settings.service';

type PaymentType = 'cash' | 'card' | 'click' | 'payme' | 'debt';
type AdminDebtSource = 'flower' | 'gift';

type LocalOrder = {
  id: string;
  _id: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  orderText: string;
  pickupDate: Date;
  totalAmount: number;
  prepaidAmount: number;
  debtAmount: number;
  status: OrderStatus;
  note: string;
  isTelegramNotified: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type LocalSale = {
  id: string;
  _id: string;
  productName: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  amount: number;
  paidAmount: number;
  debtAmount: number;
  paymentType: PaymentType;
  note: string;
  createdAt: Date;
  updatedAt: Date;
};

type LocalTelegramUser = {
  id: string;
  chatId: string;
  phone: string;
  firstName?: string;
  username?: string;
};

type LocalNotification = {
  id: string;
  phone: string;
  type: string;
  message: string;
  status: string;
  createdAt: string;
};

const FAILED_NOTIFICATION_RETRY_INTERVAL_MS = 30_000;
const INTERNET_REQUIRED_NOTIFICATION_PHONE = '+0000000';
const INTERNET_REQUIRED_NOTIFICATION_TYPE = 'telegram_internet_required';
const INTERNET_REQUIRED_MESSAGE =
  'Telegram xabar yuborilmadi. Kompyuterni internetga ulang, keyin yuborilmagan xabarlar avtomatik qayta yuboriladi.';
const TELEGRAM_NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EFATAL',
]);

export type OrderTelegramDetails = {
  customerName: string;
  orderText: string;
  pickupDate: Date;
  totalAmount: number;
  prepaidAmount: number;
  debtAmount: number;
  note?: string;
};

export type SaleTelegramDetails = {
  customerName?: string;
  productName?: string;
  amount: number;
  paidAmount: number;
  debtAmount: number;
  paymentType: PaymentType;
  note?: string;
};

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: TelegramBot;
  private lastAutomaticAdminAlertAt?: Date;
  private failedNotificationRetryTimer?: NodeJS.Timeout;
  private failedNotificationRetryInProgress = false;
  private currentBotToken = '';
  private removeTelegramSettingsListener?: () => boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly settingsService: SettingsService,
    private readonly database: LocalDatabaseService,
  ) {}

  async onModuleInit() {
    await this.database.open();
    this.removeTelegramSettingsListener = this.settingsService.onTelegramSettingsChanged(() => void this.configureBotFromSettings());
    await this.configureBotFromSettings();
  }

  onModuleDestroy() {
    this.removeTelegramSettingsListener?.();
    void this.stopBot();
  }

  private async configureBotFromSettings() {
    const token = await this.settingsService.getTelegramBotToken();
    if (!token || token === 'your_telegram_bot_token') {
      await this.stopBot();
      this.logger.warn('Telegram bot token is not configured');
      return;
    }

    if (this.bot && this.currentBotToken === token) return;

    await this.stopBot();
    this.currentBotToken = token;
    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('polling_error', (error) => {
      if (this.isTelegramNetworkError(error)) void this.createInternetRequiredNotification(error);
    });
    this.registerHandlers();
    this.startFailedNotificationRetry();
  }

  private startFailedNotificationRetry() {
    if (this.failedNotificationRetryTimer) clearInterval(this.failedNotificationRetryTimer);
    void this.retryFailedNotifications();
    this.failedNotificationRetryTimer = setInterval(() => void this.retryFailedNotifications(), FAILED_NOTIFICATION_RETRY_INTERVAL_MS);
    this.failedNotificationRetryTimer.unref?.();
  }

  private async stopBot() {
    if (this.failedNotificationRetryTimer) clearInterval(this.failedNotificationRetryTimer);
    this.failedNotificationRetryTimer = undefined;
    const bot = this.bot;
    this.bot = undefined;
    this.currentBotToken = '';
    try {
      await bot?.stopPolling();
    } catch (error) {
      this.logger.warn(`Telegram polling stop failed: ${this.errorMessage(error)}`);
    }
  }

  async sendOrderAccepted(phone: string, details: OrderTelegramDetails) {
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramOrderAcceptedEnabled) return { sent: false };
    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      'Buyurtmangiz qabul qilindi.',
      '',
      this.orderDetailsBlock(details),
    ].join('\n');
    return this.sendByPhone(phone, 'order_accepted', message);
  }

  async sendOrderStatusChanged(phone: string, status: OrderStatus, details: OrderTelegramDetails) {
    if (status === 'new') return { sent: false };
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramOrderStatusEnabled) return { sent: false };

    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      this.statusMessage(status),
      '',
      this.orderDetailsBlock(details),
      `Status: ${this.orderStatusLabel(status)}`,
    ].join('\n');
    return this.sendByPhone(phone, 'order_status', message);
  }

  async sendOrderReady(phone: string, details: OrderTelegramDetails) {
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramOrderStatusEnabled) return { sent: false };
    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      'Buyurtmangiz tayyor bo\'ldi.',
      '',
      this.orderDetailsBlock(details),
      'Status: Tayyor',
    ].join('\n');
    return this.sendByPhone(phone, 'order_ready', message);
  }

  async sendPickupDue(phone: string, details: OrderTelegramDetails) {
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramOrderStatusEnabled) return { sent: false };
    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      'Buyurtmani olib ketish vaqti yaqinlashdi.',
      '',
      this.orderDetailsBlock(details),
    ].join('\n');
    return this.sendByPhone(phone, 'pickup_due', message);
  }

  async sendDebtReminder(phone: string, details: OrderTelegramDetails) {
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramDebtReminderEnabled) return { sent: false };
    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      settings.debtReminderText || 'Qarzdorlik bo\'yicha eslatma.',
      '',
      this.orderDebtReminderBlock(details),
    ].join('\n');
    return this.sendByPhone(phone, 'debt_reminder', message);
  }

  async sendDebtPaymentReceived(phone: string, details: OrderTelegramDetails, paymentAmount: number) {
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramDebtPaymentEnabled) return { sent: false };
    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum, ${details.customerName}!`,
      details.debtAmount === 0 ? 'Buyurtmangiz bo\'yicha qarzdorlik to\'liq yopildi.' : 'Qarzingiz uchun to\'lov qabul qilindi.',
      '',
      `To'langan summa: ${this.formatMoney(paymentAmount)}`,
      this.orderDetailsBlock(details),
      '',
      'Rahmat!',
    ].join('\n');
    return this.sendByPhone(phone, 'debt_payment', message);
  }

  async sendSaleCreated(phone: string, details: SaleTelegramDetails) {
    if (!phone) return { sent: false };
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramSaleCreatedEnabled) return { sent: false };

    const message =
      details.debtAmount > 0
        ? this.saleDebtMessage(details, 'Sovg\'a/tovar xaridingiz nasiyaga rasmiylashtirildi.', settings.storeName)
        : [
            settings.storeName,
            '',
            `Assalomu alaykum${details.customerName ? `, ${details.customerName}` : ''}!`,
            'Xaridingiz qabul qilindi.',
            '',
            this.saleDetailsBlock(details),
            '',
            'Rahmat!',
          ].join('\n');
    return this.sendByPhone(phone, 'sale_created', message);
  }

  async sendSaleDebtReminder(phone: string, details: SaleTelegramDetails) {
    if (!phone) return { sent: false };
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramDebtReminderEnabled) return { sent: false };

    const message = this.saleDebtMessage(details, settings.debtReminderText || 'Qarzdorlik bo\'yicha eslatma.', settings.storeName);
    return this.sendByPhone(phone, 'sale_debt_reminder', message);
  }

  async sendSaleDebtPaymentReceived(phone: string, details: SaleTelegramDetails, paymentAmount: number) {
    if (!phone) return { sent: false };
    const settings = await this.settingsService.getSettings();
    if (!settings.telegramDebtPaymentEnabled) return { sent: false };

    const message = [
      settings.storeName,
      '',
      `Assalomu alaykum${details.customerName ? `, ${details.customerName}` : ''}!`,
      details.debtAmount === 0 ? 'Xaridingiz bo\'yicha qarzdorlik to\'liq yopildi.' : 'Xaridingiz bo\'yicha to\'lov qabul qilindi.',
      '',
      `To'langan summa: ${this.formatMoney(paymentAmount)}`,
      this.saleDetailsBlock(details),
      '',
      'Rahmat!',
    ].join('\n');
    return this.sendByPhone(phone, 'sale_debt_payment', message);
  }

  async notifyAdminsNewOrder(order: LocalOrder) {
    await this.sendToAdmins(
      [
        'Yangi gul buyurtmasi',
        '',
        `Mijoz: ${order.customerName}`,
        `Telefon: ${order.phone}`,
        `Buyurtma: ${order.orderText}`,
        `Olib ketish: ${this.formatDate(order.pickupDate)}`,
        `Summa: ${this.formatMoney(order.totalAmount)}`,
        `Qarz: ${this.formatMoney(order.debtAmount)}`,
      ].join('\n'),
      this.orderStatusKeyboard(String(order._id)),
    );
  }

  async notifyAdminsNewSale(sale: LocalSale) {
    await this.sendToAdmins(
      [
        'Yangi sovg‘a/tovar sotildi',
        '',
        `Tovar: ${sale.productName || 'Sovga/tovar'}`,
        `Mijoz: ${sale.customerName || '-'}`,
        `Telefon: ${sale.phone || '-'}`,
        `Summa: ${this.formatMoney(sale.amount)}`,
        `Qarz: ${this.formatMoney(sale.debtAmount)}`,
      ].join('\n'),
    );
  }

  async notifyAdminsDebtPayment(source: AdminDebtSource, item: LocalOrder | LocalSale, paymentAmount: number) {
    const isFlower = source === 'flower';
    const title = isFlower ? (item as LocalOrder).orderText : (item as LocalSale).productName || 'Sovga/tovar';
    const customerName = isFlower ? (item as LocalOrder).customerName : (item as LocalSale).customerName || '-';
    await this.sendToAdmins(
      [
        'Qarz to‘lovi qabul qilindi',
        '',
        `Turi: ${isFlower ? 'Gul buyurtmasi' : 'Sovg‘a/tovar'}`,
        `Mijoz: ${customerName}`,
        `Nomi: ${title}`,
        `To‘langan: ${this.formatMoney(paymentAmount)}`,
        `Qolgan qarz: ${this.formatMoney(item.debtAmount)}`,
      ].join('\n'),
    );
  }

  async notifyAdminsImportantAlerts(force = false) {
    if (!force && this.lastAutomaticAdminAlertAt && Date.now() - this.lastAutomaticAdminAlertAt.getTime() < 6 * 60 * 60 * 1000) {
      return;
    }
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    const pickupToday = this.scalar(
      "SELECT COUNT(*) FROM orders WHERE pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')",
      [todayStart.toISOString(), todayEnd.toISOString()],
    );
    const overdue = this.scalar("SELECT COUNT(*) FROM orders WHERE pickupDate < ? AND status NOT IN ('picked_up', 'cancelled')", [
      now.toISOString(),
    ]);
    const debtOrders = this.scalar("SELECT COUNT(*) FROM orders WHERE debtAmount > 0 AND status != 'cancelled'");
    const debtSales = this.scalar('SELECT COUNT(*) FROM sales WHERE debtAmount > 0');

    if (pickupToday + overdue + debtOrders + debtSales === 0) return;

    await this.sendToAdmins(
      [
        'Muhim ogohlantirishlar',
        '',
        `Bugun olib ketiladi: ${pickupToday}`,
        `Kechikkan buyurtmalar: ${overdue}`,
        `Gul qarzdorlari: ${debtOrders}`,
        `Sovg‘a/tovar qarzdorlari: ${debtSales}`,
      ].join('\n'),
    );
    if (!force) this.lastAutomaticAdminAlertAt = new Date();
  }

  async notifyAdminsSystemError(error: {
    requestId: string;
    timestamp: string;
    status: number;
    method: string;
    path: string;
    message: string;
    errorName: string;
    userId?: string;
    stack?: string;
  }) {
    const message = [
      'Backend xatolik',
      '',
      `Status: ${error.status}`,
      `Route: ${error.method} ${error.path}`,
      `Request ID: ${error.requestId}`,
      `Vaqt: ${error.timestamp}`,
      error.userId ? `User: ${error.userId}` : undefined,
      `Xabar: ${error.message}`,
      `Turi: ${error.errorName}`,
      error.stack ? ['', error.stack].join('\n') : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    await this.sendToAdmins(message);
  }

  private async sendByPhone(phone: string, type: string, message: string) {
    const normalized = normalizePhone(phone);
    const user = this.telegramUserByPhone(normalized);
    if (!this.bot || !user) {
      await this.notifications.create(normalized, type, message, 'failed');
      return { sent: false };
    }
    try {
      await this.bot.sendMessage(user.chatId, message);
      await this.notifications.create(normalized, type, message, 'sent');
      this.resolveInternetRequiredNotification();
      return { sent: true };
    } catch (error) {
      this.logger.warn(`Telegram message could not be sent to ${normalized}: ${this.errorMessage(error)}`);
      await this.notifications.create(normalized, type, message, 'failed');
      if (this.isTelegramNetworkError(error)) await this.createInternetRequiredNotification(error);
      return { sent: false };
    }
  }

  private envAdminChatIds() {
    const fromEnv = this.config.get<string>('TELEGRAM_ADMIN_IDS');
    return (fromEnv || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  private async adminChatIds() {
    return [...new Set([...this.envAdminChatIds(), ...(await this.settingsService.getTelegramAdminIds())])];
  }

  private async isAdminChat(chatId?: number | string) {
    return chatId !== undefined && (await this.adminChatIds()).includes(String(chatId));
  }

  private async sendToAdmins(message: string, replyMarkup?: TelegramBot.SendMessageOptions['reply_markup']) {
    if (!this.bot) return;
    const adminIds = await this.adminChatIds();
    await Promise.all(
      adminIds.map(async (chatId) => {
        try {
          await this.bot?.sendMessage(chatId, message, replyMarkup ? { reply_markup: replyMarkup } : undefined);
          this.resolveInternetRequiredNotification();
        } catch (error) {
          if (this.isTelegramNetworkError(error)) await this.createInternetRequiredNotification(error);
        }
      }),
    );
  }

  private orderStatusKeyboard(orderId: string) {
    return {
      inline_keyboard: [
        [
          { text: 'Jarayonda', callback_data: `status:${orderId}:in_progress` },
          { text: 'Tayyor', callback_data: `status:${orderId}:ready` },
        ],
        [
          { text: 'Olib ketildi', callback_data: `status:${orderId}:picked_up` },
          { text: 'Bekor qilindi', callback_data: `status:${orderId}:cancelled` },
        ],
      ],
    };
  }

  private debtReminderKeyboard(source: AdminDebtSource, id: string) {
    return {
      inline_keyboard: [[{ text: 'Qarz eslatmasi yuborish', callback_data: `debt:${source}:${id}` }]],
    };
  }

  private async assertAdmin(msg: TelegramBot.Message) {
    if (await this.isAdminChat(msg.chat.id)) return true;
    await this.bot?.sendMessage(msg.chat.id, 'Bu buyruq faqat admin uchun.');
    return false;
  }

  private async sendAdminReport(chatId: number) {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const todayOrders = this.scalar('SELECT COUNT(*) FROM orders WHERE createdAt >= ? AND createdAt <= ?', [
      start.toISOString(),
      end.toISOString(),
    ]);
    const todaySales = this.scalar('SELECT COUNT(*) FROM sales WHERE createdAt >= ? AND createdAt <= ?', [
      start.toISOString(),
      end.toISOString(),
    ]);
    const sales = this.database.get<{ amount: number; paid: number; profit: number }>(
      'SELECT COALESCE(SUM(amount), 0) as amount, COALESCE(SUM(paidAmount), 0) as paid, COALESCE(SUM(profit), 0) as profit FROM sales WHERE createdAt >= ? AND createdAt <= ?',
      [start.toISOString(), end.toISOString()],
    ) || { amount: 0, paid: 0, profit: 0 };
    const totalDebt =
      this.scalar("SELECT COALESCE(SUM(debtAmount), 0) FROM orders WHERE debtAmount > 0 AND status != 'cancelled'") +
      this.scalar('SELECT COALESCE(SUM(debtAmount), 0) FROM sales WHERE debtAmount > 0');
    await this.bot?.sendMessage(
      chatId,
      [
        'Kunlik hisobot',
        '',
        `Bugungi buyurtmalar: ${todayOrders}`,
        `Bugungi sovg‘a/tovar sotuvlari: ${todaySales}`,
        `Bugungi savdo: ${this.formatMoney(sales.amount || 0)}`,
        `Bugungi tushum: ${this.formatMoney(sales.paid || 0)}`,
        `Bugungi foyda: ${this.formatMoney(sales.profit || 0)}`,
        `Jami qarz: ${this.formatMoney(totalDebt)}`,
      ].join('\n'),
    );
  }

  private async sendAdminOrders(chatId: number, mode: 'today' | 'overdue') {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const orders =
      mode === 'today'
        ? this.orders("pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')", [
            start.toISOString(),
            end.toISOString(),
          ], 'pickupDate ASC', 10)
        : this.orders("pickupDate < ? AND status NOT IN ('picked_up', 'cancelled')", [now.toISOString()], 'pickupDate ASC', 10);
    if (orders.length === 0) {
      await this.bot?.sendMessage(chatId, mode === 'today' ? 'Bugun olib ketiladigan buyurtma yo‘q.' : 'Kechikkan buyurtma yo‘q.');
      return;
    }
    for (const order of orders) {
      await this.bot?.sendMessage(
        chatId,
        [
          mode === 'today' ? 'Bugungi buyurtma' : 'Kechikkan buyurtma',
          '',
          `Mijoz: ${order.customerName}`,
          `Telefon: ${order.phone}`,
          `Buyurtma: ${order.orderText}`,
          `Olib ketish: ${this.formatDate(order.pickupDate)}`,
          `Status: ${this.orderStatusLabel(order.status)}`,
          `Qarz: ${this.formatMoney(order.debtAmount)}`,
        ].join('\n'),
        { reply_markup: this.orderStatusKeyboard(String(order._id)) },
      );
    }
  }

  private async sendAdminDebts(chatId: number) {
    const orders = this.orders("debtAmount > 0 AND status != 'cancelled'", [], 'debtAmount DESC', 5);
    const sales = this.sales('debtAmount > 0', [], 'debtAmount DESC', 5);
    if (orders.length + sales.length === 0) {
      await this.bot?.sendMessage(chatId, 'Qarzdorlar yo‘q.');
      return;
    }
    for (const order of orders) {
      await this.bot?.sendMessage(
        chatId,
        [`Gul qarzi`, '', `Mijoz: ${order.customerName}`, `Telefon: ${order.phone}`, `Buyurtma: ${order.orderText}`, `Qarz: ${this.formatMoney(order.debtAmount)}`].join('\n'),
        { reply_markup: this.debtReminderKeyboard('flower', String(order._id)) },
      );
    }
    for (const sale of sales) {
      await this.bot?.sendMessage(
        chatId,
        [`Sovg‘a/tovar qarzi`, '', `Mijoz: ${sale.customerName || '-'}`, `Telefon: ${sale.phone || '-'}`, `Tovar: ${sale.productName}`, `Qarz: ${this.formatMoney(sale.debtAmount)}`].join('\n'),
        { reply_markup: this.debtReminderKeyboard('gift', String(sale._id)) },
      );
    }
  }

  private async sendAdminSearch(chatId: number, query: string) {
    const search = escapeRegex(query.trim());
    if (!search) {
      await this.bot?.sendMessage(chatId, 'Qidirish uchun: /qidir Ali yoki /qidir 901234567');
      return;
    }
    const like = `%${search.replace(/[%_]/g, '\\$&')}%`;
    const orders = this.orders(
      `(customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR telegramPhone LIKE ? ESCAPE '\\' OR orderText LIKE ? ESCAPE '\\')`,
      [like, like, like, like],
      'createdAt DESC',
      5,
    );
    const sales = this.sales(
      `(productName LIKE ? ESCAPE '\\' OR customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`,
      [like, like, like, like],
      'createdAt DESC',
      5,
    );
    const parts = [
      'Qidiruv natijalari',
      '',
      ...orders.map((order, index) => `${index + 1}. Gul: ${order.customerName} | ${order.orderText} | ${this.formatMoney(order.debtAmount)} qarz`),
      ...sales.map((sale, index) => `${orders.length + index + 1}. Tovar: ${sale.productName} | ${sale.customerName || '-'} | ${this.formatMoney(sale.debtAmount)} qarz`),
    ];
    await this.bot?.sendMessage(chatId, orders.length + sales.length ? parts.join('\n') : 'Natija topilmadi.');
  }

  private async sendAdminHealth(chatId: number) {
    const orders = this.scalar('SELECT COUNT(*) FROM orders');
    const sales = this.scalar('SELECT COUNT(*) FROM sales');
    const users = this.scalar('SELECT COUNT(*) FROM telegram_users');
    await this.bot?.sendMessage(
      chatId,
      ['Texnik holat', '', `Bot: ishlayapti`, `Backend: ishlayapti`, `Buyurtmalar: ${orders}`, `Sotuvlar: ${sales}`, `Telegram foydalanuvchilar: ${users}`, `Vaqt: ${this.formatDate(new Date())}`].join('\n'),
    );
  }

  private adminMainKeyboard() {
    return {
      inline_keyboard: [
        [{ text: 'Buyurtmalar', callback_data: 'admin:orders' }],
        [{ text: 'Qarzlar', callback_data: 'admin:debts' }],
        [
          { text: 'Qidirish', callback_data: 'admin:search' },
          { text: 'Sozlamalar', callback_data: 'admin:settings' },
        ],
      ],
    };
  }

  private adminOrdersKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: 'Bugungi buyurtmalar', callback_data: 'admin:orders:today' },
          { text: 'Kechikkanlar', callback_data: 'admin:orders:overdue' },
        ],
        [{ text: 'Orqaga', callback_data: 'admin:menu' }],
      ],
    };
  }

  private adminDebtsKeyboard() {
    return {
      inline_keyboard: [[{ text: 'Qarzdorlar ro\'yxati', callback_data: 'admin:debts:list' }], [{ text: 'Orqaga', callback_data: 'admin:menu' }]],
    };
  }

  private adminSettingsKeyboard() {
    return {
      inline_keyboard: [
        [{ text: 'Adminlar', callback_data: 'admin:settings:admins' }],
        [{ text: 'Orqaga', callback_data: 'admin:menu' }],
      ],
    };
  }

  private adminReplyKeyboard() {
    return {
      keyboard: [
        [{ text: 'Bosh menyu' }, { text: 'Hisobot' }],
        [{ text: 'Bugungi buyurtmalar' }, { text: 'Qarzlar' }],
        [{ text: 'Kechikkanlar' }, { text: 'Texnik holat' }],
      ],
      resize_keyboard: true,
    };
  }

  private async sendAdminMenuLegacy(chatId: number) {
    await this.bot?.sendMessage(
      chatId,
      [
        'Admin panel',
        '',
        '/hisobot - kunlik hisobot',
        '/qarzlar - qarzdorlar ro‘yxati',
        '/bugun - bugun olib ketiladigan buyurtmalar',
        '/kechikkan - kechikkan buyurtmalar',
        '/qidir matn - buyurtma/sotuv/qarzdor qidirish',
        '/ogohlantirishlar - muhim ogohlantirishlar',
        '/holat - bot/backend holati',
        '/adminlar - admin chat ID lar',
        '/admin_qosh chat_id - admin qo\'shish',
        '/admin_ochir chat_id - adminni olib tashlash',
      ].join('\n'),
      {
        reply_markup: {
          keyboard: [
            [{ text: '/hisobot' }, { text: '/bugun' }],
            [{ text: '/qarzlar' }, { text: '/kechikkan' }],
            [{ text: '/ogohlantirishlar' }, { text: '/holat' }],
          ],
          resize_keyboard: true,
        },
      },
    );
  }

  private async sendAdminMenu(chatId: number) {
    await this.bot?.sendMessage(
      chatId,
      ['Admin panel', '', 'Pastdagi tugmalar tezkor amallar uchun. Ichki bo\'limlarga kirish uchun navigatsiya tugmalaridan foydalaning.'].join('\n'),
      { reply_markup: this.adminMainKeyboard() },
    );
    await this.bot?.sendMessage(chatId, 'Tezkor panel yangilandi.', { reply_markup: this.adminReplyKeyboard() });
  }

  private registerHandlers() {
    if (!this.bot) return;
    this.bot.onText(/^\/admin$/, async (msg) => {
      if (!(await this.assertAdmin(msg))) return;
      await this.sendAdminMenu(msg.chat.id);
    });

    this.bot.onText(/^Bosh menyu$/i, async (msg) => {
      if (!(await this.assertAdmin(msg))) return;
      await this.sendAdminMenu(msg.chat.id);
    });

    this.bot.onText(/^\/hisobot$/, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminReport(msg.chat.id);
    });

    this.bot.onText(/^Hisobot$/i, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminReport(msg.chat.id);
    });

    this.bot.onText(/^\/qarzlar$/, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminDebts(msg.chat.id);
    });

    this.bot.onText(/^Qarzlar$/i, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminDebts(msg.chat.id);
    });

    this.bot.onText(/^\/bugun$/, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminOrders(msg.chat.id, 'today');
    });

    this.bot.onText(/^Bugungi buyurtmalar$/i, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminOrders(msg.chat.id, 'today');
    });

    this.bot.onText(/^\/kechikkan$/, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminOrders(msg.chat.id, 'overdue');
    });

    this.bot.onText(/^Kechikkanlar$/i, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminOrders(msg.chat.id, 'overdue');
    });

    this.bot.onText(/^\/qidir(?:\s+(.+))?$/, async (msg, match) => {
      if (await this.assertAdmin(msg)) await this.sendAdminSearch(msg.chat.id, match?.[1] || '');
    });

    this.bot.onText(/^\/ogohlantirishlar$/, async (msg) => {
      if (!(await this.assertAdmin(msg))) return;
      await this.notifyAdminsImportantAlerts(true);
    });

    this.bot.onText(/^\/holat$/, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminHealth(msg.chat.id);
    });

    this.bot.onText(/^Texnik holat$/i, async (msg) => {
      if (await this.assertAdmin(msg)) await this.sendAdminHealth(msg.chat.id);
    });

    this.bot.onText(/^\/adminlar$/, async (msg) => {
      if (!(await this.assertAdmin(msg))) return;
      const adminIds = await this.adminChatIds();
      await this.bot?.sendMessage(msg.chat.id, adminIds.length ? `Admin chat ID lar:\n${adminIds.join('\n')}` : 'Admin chat ID topilmadi.');
    });

    this.bot.onText(/^\/admin_qosh(?:\s+(-?\d+))?$/, async (msg, match) => {
      if (!(await this.assertAdmin(msg))) return;
      const chatId = match?.[1];
      if (!chatId) {
        await this.bot?.sendMessage(msg.chat.id, 'Foydalanish: /admin_qosh 123456789');
        return;
      }
      await this.settingsService.addTelegramAdminId(chatId);
      await this.bot?.sendMessage(msg.chat.id, `Admin qo'shildi: ${chatId}`);
    });

    this.bot.onText(/^\/admin_ochir(?:\s+(-?\d+))?$/, async (msg, match) => {
      if (!(await this.assertAdmin(msg))) return;
      const chatId = match?.[1];
      if (!chatId) {
        await this.bot?.sendMessage(msg.chat.id, 'Foydalanish: /admin_ochir 123456789');
        return;
      }
      if (this.envAdminChatIds().includes(chatId)) {
        await this.bot?.sendMessage(msg.chat.id, 'Bu admin .env orqali berilgan, uni Settingsdan o\'chirib bo\'lmaydi.');
        return;
      }
      await this.settingsService.removeTelegramAdminId(chatId);
      await this.bot?.sendMessage(msg.chat.id, `Admin olib tashlandi: ${chatId}`);
    });

    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId || !(await this.isAdminChat(chatId)) || !query.data) {
        await this.bot?.answerCallbackQuery(query.id, { text: 'Ruxsat yo‘q' });
        return;
      }

      const [type, idOrSource, value] = query.data.split(':');
      try {
        if (type === 'admin') {
          await this.bot?.answerCallbackQuery(query.id);

          if (idOrSource === 'menu') {
            await this.sendAdminMenu(chatId);
            return;
          }

          if (idOrSource === 'report') {
            await this.sendAdminReport(chatId);
            return;
          }

          if (idOrSource === 'orders') {
            if (value === 'today') {
              await this.sendAdminOrders(chatId, 'today');
              return;
            }
            if (value === 'overdue') {
              await this.sendAdminOrders(chatId, 'overdue');
              return;
            }
            await this.bot?.sendMessage(chatId, 'Buyurtmalar bo\'limi', { reply_markup: this.adminOrdersKeyboard() });
            return;
          }

          if (idOrSource === 'debts') {
            if (value === 'list') {
              await this.sendAdminDebts(chatId);
              return;
            }
            await this.bot?.sendMessage(chatId, 'Qarzlar bo\'limi', { reply_markup: this.adminDebtsKeyboard() });
            return;
          }

          if (idOrSource === 'alerts') {
            await this.notifyAdminsImportantAlerts(true);
            return;
          }

          if (idOrSource === 'health') {
            await this.sendAdminHealth(chatId);
            return;
          }

          if (idOrSource === 'search') {
            await this.bot?.sendMessage(chatId, 'Qidirish uchun xabar yuboring:\n/qidir ism yoki telefon');
            return;
          }

          if (idOrSource === 'settings') {
            if (value === 'admins') {
              const adminIds = await this.adminChatIds();
              await this.bot?.sendMessage(
                chatId,
                [
                  'Telegram adminlar',
                  '',
                  adminIds.length ? adminIds.join('\n') : 'Admin chat ID topilmadi.',
                  '',
                  'Qo\'shish: /admin_qosh 123456789',
                  'Olib tashlash: /admin_ochir 123456789',
                ].join('\n'),
                { reply_markup: this.adminSettingsKeyboard() },
              );
              return;
            }
            await this.bot?.sendMessage(chatId, 'Sozlamalar bo\'limi', { reply_markup: this.adminSettingsKeyboard() });
            return;
          }
        }

        if (type === 'status') {
          const order = this.orderById(idOrSource);
          if (!order) throw new Error('Order not found');
          order.status = value as OrderStatus;
          if (order.status === 'ready') order.isTelegramNotified = true;
          this.database.run('UPDATE orders SET status = ?, isTelegramNotified = ?, updatedAt = ? WHERE id = ?', [
            order.status,
            order.isTelegramNotified ? 1 : 0,
            new Date().toISOString(),
            order.id,
          ]);
          await this.bot?.answerCallbackQuery(query.id, { text: 'Status yangilandi' });
          await this.bot?.sendMessage(chatId, `${order.customerName} buyurtmasi statusi: ${this.orderStatusLabel(order.status)}`);
          await this.sendOrderStatusChanged(order.telegramPhone || order.phone, order.status, this.orderTelegramDetails(order));
        }

        if (type === 'debt') {
          const source = idOrSource as AdminDebtSource;
          if (source === 'flower') {
            const order = this.orderById(value);
            if (!order) throw new Error('Order not found');
            await this.sendDebtReminder(order.telegramPhone || order.phone, this.orderTelegramDetails(order));
          } else {
            const sale = this.saleById(value);
            if (!sale) throw new Error('Sale not found');
            await this.sendSaleDebtReminder(sale.phone, this.saleTelegramDetails(sale));
          }
          await this.bot?.answerCallbackQuery(query.id, { text: 'Eslatma yuborildi' });
        }
      } catch {
        await this.bot?.answerCallbackQuery(query.id, { text: 'Amal bajarilmadi' });
      }
    });

    this.bot.onText(/^Buyurtma holatini tekshirish$/i, async (msg) => {
      const user = this.telegramUserByChatId(String(msg.chat.id));
      if (!user?.phone) {
        await this.bot?.sendMessage(msg.chat.id, 'Buyurtma holatini tekshirish uchun avval telefon raqamingizni yuboring.', {
          reply_markup: {
            keyboard: [[{ text: 'Telefon raqamni yuborish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
        return;
      }

      const orders = this.orders('(phone = ? OR telegramPhone = ?)', [user.phone, user.phone], 'updatedAt DESC, createdAt DESC', 5);

      if (orders.length === 0) {
        await this.bot?.sendMessage(msg.chat.id, 'Hozircha sizga bog‘langan buyurtma topilmadi.');
        return;
      }

      const message = [
        await this.settingsService.getStoreName(),
        '',
        'Buyurtmalaringiz holati:',
        '',
        orders
          .map((order, index) =>
            [
              `${index + 1}. ${order.orderText}`,
              `Status: ${this.orderStatusLabel(order.status)}`,
              `Olib ketish vaqti: ${this.formatDate(order.pickupDate)}`,
              `Umumiy summa: ${this.formatMoney(order.totalAmount)}`,
              `Qolgan qarz: ${this.formatMoney(order.debtAmount)}`,
            ].join('\n'),
          )
          .join('\n\n'),
      ].join('\n');

      await this.bot?.sendMessage(msg.chat.id, message);
    });

    this.bot.onText(/\/start/, async (msg) => {
      if (await this.isAdminChat(msg.chat.id)) {
        await this.sendAdminMenu(msg.chat.id);
        return;
      }
      this.bot?.sendMessage(msg.chat.id, `${await this.settingsService.getStoreName()} botiga xush kelibsiz. Telefon raqamingizni yuboring.`, {
        reply_markup: {
          keyboard: [[{ text: 'Telefon raqamni yuborish', request_contact: true }], [{ text: 'Buyurtma holatini tekshirish' }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
    });

    this.bot.on('contact', async (msg) => {
      if (!msg.contact?.phone_number) return;
      const phone = normalizePhone(msg.contact.phone_number);
      this.upsertTelegramUser(String(msg.chat.id), phone, msg.from?.first_name, msg.from?.username);
      await this.bot?.sendMessage(msg.chat.id, 'Rahmat! Endi buyurtma va xarid xabarlarini shu yerda olasiz.', {
        reply_markup: {
          keyboard: [[{ text: 'Buyurtma holatini tekshirish' }]],
          resize_keyboard: true,
        },
      });
      void this.retryFailedNotifications(phone);
    });
  }

  private async retryFailedNotifications(phone?: string) {
    if (!this.bot || this.failedNotificationRetryInProgress) return;
    this.failedNotificationRetryInProgress = true;

    try {
      const notifications = this.failedTelegramNotifications(phone);
      for (const notification of notifications) {
        const normalized = normalizePhone(notification.phone);
        const user = this.telegramUserByPhone(normalized);
        if (!user) continue;

        try {
          await this.bot.sendMessage(user.chatId, notification.message);
          this.markNotificationSent(notification.id);
          this.resolveInternetRequiredNotification();
        } catch (error) {
          this.logger.warn(`Telegram failed notification retry failed for ${normalized}: ${this.errorMessage(error)}`);
          if (this.isTelegramNetworkError(error)) await this.createInternetRequiredNotification(error);
          break;
        }
      }
      await this.resolveInternetNotificationIfReachable();
    } catch (error) {
      this.logger.warn(`Telegram failed notification retry skipped: ${this.errorMessage(error)}`);
    } finally {
      this.failedNotificationRetryInProgress = false;
    }
  }

  private failedTelegramNotifications(phone?: string) {
    const normalized = phone ? normalizePhone(phone) : '';
    const where = normalized
      ? `status = 'failed' AND resolvedAt IS NULL AND type != '${INTERNET_REQUIRED_NOTIFICATION_TYPE}' AND phone = ?`
      : `status = 'failed' AND resolvedAt IS NULL AND type != '${INTERNET_REQUIRED_NOTIFICATION_TYPE}'`;
    const params = normalized ? [normalized] : [];
    return this.database.all<LocalNotification>(
      `SELECT id, phone, type, message, status, createdAt
       FROM notifications
       WHERE ${where}
       ORDER BY createdAt ASC
       LIMIT 20`,
      params,
    );
  }

  private markNotificationSent(id: string) {
    const now = new Date().toISOString();
    this.database.run("UPDATE notifications SET status = 'sent', sentAt = ?, updatedAt = ? WHERE id = ?", [now, now, id]);
  }

  private async createInternetRequiredNotification(error: unknown) {
    try {
      if (this.internetRequiredNotification()) return;

      this.logger.warn(`Telegram internet is unavailable: ${this.errorMessage(error)}`);
      await this.notifications.create(
        INTERNET_REQUIRED_NOTIFICATION_PHONE,
        INTERNET_REQUIRED_NOTIFICATION_TYPE,
        INTERNET_REQUIRED_MESSAGE,
        'failed',
      );
    } catch (notificationError) {
      this.logger.warn(`Telegram internet notification could not be created: ${this.errorMessage(notificationError)}`);
    }
  }

  private async resolveInternetNotificationIfReachable() {
    if (!this.bot || !this.internetRequiredNotification()) return;

    try {
      await this.bot.getMe();
      this.resolveInternetRequiredNotification();
    } catch (error) {
      if (!this.isTelegramNetworkError(error)) {
        this.logger.warn(`Telegram connectivity check failed: ${this.errorMessage(error)}`);
      }
    }
  }

  private internetRequiredNotification() {
    return this.database.get<LocalNotification>(
      "SELECT id, phone, type, message, status, createdAt FROM notifications WHERE type = ? AND status = 'failed' AND resolvedAt IS NULL LIMIT 1",
      [INTERNET_REQUIRED_NOTIFICATION_TYPE],
    );
  }

  private resolveInternetRequiredNotification() {
    const now = new Date().toISOString();
    this.database.run(
      `UPDATE notifications SET resolvedAt = ?, updatedAt = ?
       WHERE type = ? AND status = 'failed' AND resolvedAt IS NULL`,
      [now, now, INTERNET_REQUIRED_NOTIFICATION_TYPE],
    );
  }

  private isTelegramNetworkError(error: unknown) {
    const code = this.errorCode(error);
    const message = this.errorMessage(error).toLowerCase();
    return (
      TELEGRAM_NETWORK_ERROR_CODES.has(code) ||
      /getaddrinfo|network|timeout|timed out|socket|dns|enotfound|eai_again|econnreset|econnrefused|enetunreach|ehostunreach/.test(message)
    );
  }

  private errorCode(error: unknown) {
    if (!error || typeof error !== 'object') return '';
    const record = error as Record<string, unknown>;
    const cause = record.cause && typeof record.cause === 'object' ? (record.cause as Record<string, unknown>) : undefined;
    return String(record.code || cause?.code || '').toUpperCase();
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private formatDate(value: Date) {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private formatMoney(value: number) {
    return `${Number(value || 0).toLocaleString('uz-UZ')} so'm`;
  }

  private scalar(sql: string, params: Array<string | number> = []) {
    const row = this.database.get<Record<string, number>>(sql, params);
    return Number(row?.[Object.keys(row)[0]] || 0);
  }

  private orders(where: string, params: Array<string | number>, orderBy: string, limit: number) {
    return this.database
      .all<Record<string, unknown>>(`SELECT * FROM orders WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`, params)
      .map((row) => this.mapOrder(row));
  }

  private sales(where: string, params: Array<string | number>, orderBy: string, limit: number) {
    return this.database
      .all<Record<string, unknown>>(`SELECT * FROM sales WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit}`, params)
      .map((row) => this.mapSale(row));
  }

  private orderById(id: string) {
    const row = this.database.get<Record<string, unknown>>('SELECT * FROM orders WHERE id = ? LIMIT 1', [id]);
    return row ? this.mapOrder(row) : null;
  }

  private saleById(id: string) {
    const row = this.database.get<Record<string, unknown>>('SELECT * FROM sales WHERE id = ? LIMIT 1', [id]);
    return row ? this.mapSale(row) : null;
  }

  private telegramUserByPhone(phone: string) {
    return this.database.get<LocalTelegramUser>('SELECT * FROM telegram_users WHERE phone = ? LIMIT 1', [phone]);
  }

  private telegramUserByChatId(chatId: string) {
    return this.database.get<LocalTelegramUser>('SELECT * FROM telegram_users WHERE chatId = ? LIMIT 1', [chatId]);
  }

  private upsertTelegramUser(chatId: string, phone: string, firstName?: string, username?: string) {
    const now = new Date().toISOString();
    const existing = this.telegramUserByChatId(chatId);
    if (existing) {
      this.database.run('UPDATE telegram_users SET phone = ?, firstName = ?, username = ?, updatedAt = ? WHERE chatId = ?', [
        phone,
        firstName || null,
        username || null,
        now,
        chatId,
      ]);
      return;
    }
    this.database.run(
      `INSERT INTO telegram_users (id, chatId, phone, firstName, username, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.database.createId(), chatId, phone, firstName || null, username || null, now, now],
    );
  }

  private mapOrder(row: Record<string, unknown>): LocalOrder {
    return {
      id: String(row.id),
      _id: String(row.id),
      customerName: String(row.customerName || ''),
      phone: String(row.phone || ''),
      telegramPhone: String(row.telegramPhone || ''),
      orderText: String(row.orderText || ''),
      pickupDate: new Date(String(row.pickupDate)),
      totalAmount: Number(row.totalAmount || 0),
      prepaidAmount: Number(row.prepaidAmount || 0),
      debtAmount: Number(row.debtAmount || 0),
      status: String(row.status || 'new') as OrderStatus,
      note: String(row.note || ''),
      isTelegramNotified: Boolean(row.isTelegramNotified),
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    };
  }

  private mapSale(row: Record<string, unknown>): LocalSale {
    return {
      id: String(row.id),
      _id: String(row.id),
      productName: String(row.productName || ''),
      customerName: String(row.customerName || ''),
      phone: String(row.phone || ''),
      telegramPhone: String(row.telegramPhone || ''),
      amount: Number(row.amount || 0),
      paidAmount: Number(row.paidAmount || 0),
      debtAmount: Number(row.debtAmount || 0),
      paymentType: String(row.paymentType || 'cash') as PaymentType,
      note: String(row.note || ''),
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    };
  }

  private paymentTypeLabel(value: PaymentType) {
    const labels: Record<PaymentType, string> = {
      cash: 'Naqd',
      card: 'Karta',
      click: 'Click',
      payme: 'Payme',
      debt: 'Nasiya',
    };
    return labels[value] || value;
  }

  private orderStatusLabel(status: OrderStatus) {
    const labels: Record<OrderStatus, string> = {
      new: 'Yangi',
      in_progress: 'Jarayonda',
      ready: 'Tayyor',
      picked_up: 'Olib ketildi',
      cancelled: 'Bekor qilindi',
    };
    return labels[status] || status;
  }

  private statusMessage(status: OrderStatus) {
    const messages: Record<OrderStatus, string> = {
      new: 'Buyurtma holati yangilandi.',
      in_progress: 'Buyurtmangiz tayyorlanmoqda.',
      ready: 'Buyurtmangiz tayyor bo‘ldi.',
      picked_up: 'Buyurtmangiz olib ketildi. Xaridingiz uchun rahmat!',
      cancelled: 'Buyurtmangiz bekor qilindi.',
    };
    return messages[status] || 'Buyurtma holati yangilandi.';
  }

  private orderDetailsBlock(details: OrderTelegramDetails) {
    return [
      `Buyurtma: ${details.orderText}`,
      `Olib ketish vaqti: ${this.formatDate(details.pickupDate)}`,
      `Umumiy summa: ${this.formatMoney(details.totalAmount)}`,
      `Oldindan to'lov: ${this.formatMoney(details.prepaidAmount)}`,
      `Qolgan qarz: ${this.formatMoney(details.debtAmount)}`,
      details.note ? `Izoh: ${details.note}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private orderTelegramDetails(order: LocalOrder): OrderTelegramDetails {
    return {
      customerName: order.customerName,
      orderText: order.orderText,
      pickupDate: order.pickupDate,
      totalAmount: order.totalAmount,
      prepaidAmount: order.prepaidAmount,
      debtAmount: order.debtAmount,
      note: order.note,
    };
  }

  private saleTelegramDetails(sale: LocalSale): SaleTelegramDetails {
    return {
      customerName: sale.customerName,
      productName: sale.productName,
      amount: sale.amount,
      paidAmount: sale.paidAmount,
      debtAmount: sale.debtAmount,
      paymentType: sale.paymentType,
      note: sale.note,
    };
  }

  private orderDebtReminderBlock(details: OrderTelegramDetails) {
    return [
      `Buyurtma: ${details.orderText}`,
      `Qolgan qarz: ${this.formatMoney(details.debtAmount)}`,
      'Iltimos, qolgan qarzni bartaraf eting.',
    ].join('\n');
  }

  private saleDetailsBlock(details: SaleTelegramDetails) {
    return [
      `Tovar: ${details.productName || 'Sovga/tovar'}`,
      `Umumiy summa: ${this.formatMoney(details.amount)}`,
      `To'langan: ${this.formatMoney(details.paidAmount)}`,
      `Qolgan qarz: ${this.formatMoney(details.debtAmount)}`,
      `To'lov turi: ${this.paymentTypeLabel(details.paymentType)}`,
      details.note ? `Izoh: ${details.note}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private saleDebtMessage(details: SaleTelegramDetails, intro: string, storeName: string) {
    return [
      storeName,
      '',
      `Assalomu alaykum${details.customerName ? `, ${details.customerName}` : ''}!`,
      intro,
      '',
      `Tovar: ${details.productName || 'Sovga/tovar'}`,
      `Qolgan qarz: ${this.formatMoney(details.debtAmount)}`,
      'Iltimos, qolgan qarzni bartaraf eting.',
      '',
      'Rahmat!',
    ].join('\n');
  }
}
