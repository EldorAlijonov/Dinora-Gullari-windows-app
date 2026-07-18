import { Injectable } from '@nestjs/common';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { NotificationStatus } from './schemas/notification.schema';

type AdminNotification = {
  id: string;
  order: number;
  type: string;
  tone: 'danger' | 'warning' | 'info' | 'success';
  title: string;
  message: string;
  amount?: number;
  createdAt: Date;
  url?: string;
  notificationId?: string;
};

type OrderRow = Record<string, unknown> & {
  id: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  orderText: string;
  totalAmount: number;
  debtAmount: number;
  pickupDate: string;
  updatedAt: string;
};

type SaleRow = Record<string, unknown> & {
  id: string;
  productName: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  debtAmount: number;
  createdAt: string;
};

type NotificationRow = {
  id: string;
  phone: string;
  type: string;
  message: string;
  status: NotificationStatus;
  sentAt?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const INTERNET_REQUIRED_NOTIFICATION_TYPE = 'telegram_internet_required';

@Injectable()
export class NotificationsService {
  constructor(private readonly database: LocalDatabaseService) {}

  async create(phone: string, type: string, message: string, status: NotificationStatus) {
    const normalizedPhone = normalizePhone(phone);
    const now = new Date().toISOString();
    if (status === 'sent') {
      this.database.run(
        `UPDATE notifications SET resolvedAt = ?, updatedAt = ?
         WHERE phone = ? AND type = ? AND status = 'failed' AND resolvedAt IS NULL`,
        [now, now, normalizedPhone, type],
      );
    }

    const id = this.database.createId();
    this.database.run(
      `INSERT INTO notifications (id, phone, type, message, status, sentAt, resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, normalizedPhone, type, message, status, status === 'sent' ? now : null, now, now],
    );
    return this.database.get<NotificationRow>('SELECT * FROM notifications WHERE id = ? LIMIT 1', [id]);
  }

  async adminNotifications() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const overdueOrders = this.orders(
      "pickupDate < ? AND status NOT IN ('picked_up', 'cancelled')",
      [now.toISOString()],
      'pickupDate ASC',
    );
    const pickupToday = this.orders(
      "pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')",
      [todayStart.toISOString(), todayEnd.toISOString()],
      'pickupDate ASC',
    );
    const readyOrders = this.orders("status = 'ready'", [], 'updatedAt DESC');
    const debtOrders = this.orders("debtAmount > 0 AND status != 'cancelled'", [], 'debtAmount DESC');
    const debtSales = this.database.all<SaleRow>('SELECT * FROM sales WHERE debtAmount > 0 ORDER BY createdAt DESC LIMIT 8');
    const failedTelegram = this.notifications("status = 'failed' AND resolvedAt IS NULL", 'createdAt DESC');
    const sentTelegram = this.notifications(
      `status = 'sent' AND resolvedAt IS NULL AND type != '${INTERNET_REQUIRED_NOTIFICATION_TYPE}'`,
      'sentAt DESC, createdAt DESC',
    );

    const items: Omit<AdminNotification, 'order'>[] = [
      ...overdueOrders.map((order) => ({
        id: `overdue-${order.id}`,
        type: 'overdue_order',
        tone: 'danger' as const,
        title: 'Kechikkan gul buyurtmasi',
        message: `${order.customerName} buyurtmasini olib ketish vaqti o'tib ketgan.`,
        amount: order.totalAmount,
        createdAt: new Date(order.pickupDate),
        url: `/orders?filter=overdue&highlight=${order.id}`,
      })),
      ...pickupToday.map((order) => ({
        id: `pickup-${order.id}`,
        type: 'pickup_today',
        tone: 'warning' as const,
        title: 'Bugun olib ketiladigan buyurtma',
        message: `${order.customerName} gul buyurtmasini bugun olib ketadi.`,
        amount: order.totalAmount,
        createdAt: new Date(order.pickupDate),
        url: `/orders?filter=pickup_today&highlight=${order.id}`,
      })),
      ...readyOrders.map((order) => ({
        id: `ready-${order.id}`,
        type: 'ready_order',
        tone: 'success' as const,
        title: 'Tayyor gul buyurtmasi',
        message: `${order.customerName} buyurtmasi tayyor, topshirishni nazorat qiling.`,
        amount: order.totalAmount,
        createdAt: new Date(order.updatedAt),
        url: `/orders?status=ready&highlight=${order.id}`,
      })),
      ...debtOrders.map((order) => ({
        id: `flower-debt-${order.id}`,
        type: 'flower_debt',
        tone: 'warning' as const,
        title: 'Gul buyurtmasida nasiya',
        message: `${order.customerName} buyurtmasida qolgan qarz bor.`,
        amount: order.debtAmount,
        createdAt: new Date(order.updatedAt),
        url: `/debts?search=${encodeURIComponent(order.phone)}`,
      })),
      ...debtSales.map((sale) => ({
        id: `gift-debt-${sale.id}`,
        type: 'gift_debt',
        tone: 'warning' as const,
        title: 'Sovga/tovar nasiyaga sotildi',
        message: `${sale.productName || 'Sovga/tovar'} bo'yicha qolgan qarz bor.`,
        amount: sale.debtAmount,
        createdAt: new Date(sale.createdAt),
        url: `/debts?source=gift&search=${encodeURIComponent(sale.phone || sale.telegramPhone || sale.productName || '')}`,
      })),
      ...failedTelegram.map((notification) =>
        notification.type === INTERNET_REQUIRED_NOTIFICATION_TYPE
          ? {
              id: `telegram-internet-${notification.id}`,
              notificationId: notification.id,
              type: 'telegram_internet_required',
              tone: 'danger' as const,
              title: 'Telegram uchun internet kerak',
              message: notification.message,
              createdAt: new Date(notification.createdAt),
            }
          : {
              id: `telegram-${notification.id}`,
              notificationId: notification.id,
              type: 'telegram_failed',
              tone: 'danger' as const,
              title: 'Telegram xabar yuborilmadi',
              message: `${notification.phone}: ${notification.message}`,
              createdAt: new Date(notification.createdAt),
            },
      ),
      ...sentTelegram.map((notification) => ({
        id: `telegram-sent-${notification.id}`,
        notificationId: notification.id,
        type: 'telegram_sent',
        tone: 'success' as const,
        title: 'Telegram xabar yetkazildi',
        message: `${notification.phone}: ${this.telegramTypeLabel(notification.type)} muvaffaqiyatli yuborildi.`,
        createdAt: new Date(notification.sentAt || notification.createdAt),
      })),
    ];

    return items
      .sort((a, b) => {
        const priority = { danger: 0, warning: 1, info: 2, success: 3 };
        return priority[a.tone] - priority[b.tone] || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, 30)
      .map((item, index) => ({ ...item, order: index + 1 }));
  }

  async resolve(id: string) {
    this.database.run('UPDATE notifications SET resolvedAt = ?, updatedAt = ? WHERE id = ?', [
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    ]);
    return { resolved: true };
  }

  async resolveSent() {
    const count = Number(
      this.database.get<{ count: number }>("SELECT COUNT(*) as count FROM notifications WHERE status = 'sent' AND resolvedAt IS NULL")?.count || 0,
    );
    const now = new Date().toISOString();
    this.database.run("UPDATE notifications SET resolvedAt = ?, updatedAt = ? WHERE status = 'sent' AND resolvedAt IS NULL", [now, now]);
    return { resolved: true, count };
  }

  private orders(where: string, params: Array<string | number>, orderBy: string) {
    return this.database.all<OrderRow>(`SELECT * FROM orders WHERE ${where} ORDER BY ${orderBy} LIMIT 8`, params);
  }

  private notifications(where: string, orderBy: string) {
    return this.database.all<NotificationRow>(`SELECT * FROM notifications WHERE ${where} ORDER BY ${orderBy} LIMIT 8`);
  }

  private telegramTypeLabel(type: string) {
    const labels: Record<string, string> = {
      order_accepted: 'Buyurtma qabul qilindi xabari',
      order_ready: 'Buyurtma tayyor xabari',
      order_status: 'Buyurtma holati xabari',
      pickup_due: 'Olib ketish vaqti eslatmasi',
      debt_reminder: 'Qarzdorlik eslatmasi',
      debt_payment: 'Qarz tolovi xabari',
      sale_created: 'Sovga/tovar xaridi xabari',
      sale_debt_reminder: 'Sovga/tovar qarzdorlik eslatmasi',
      sale_debt_payment: 'Sovga/tovar qarz tolovi xabari',
      telegram_internet_required: 'Telegram uchun internet kerak',
    };
    return labels[type] || 'Telegram xabar';
  }
}
