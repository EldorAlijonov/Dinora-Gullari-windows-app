import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { TelegramService } from './telegram.service';

type PickupDueOrder = {
  id: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  orderText: string;
  pickupDate: string;
  totalAmount: number;
  prepaidAmount: number;
  debtAmount: number;
  note: string;
};

@Injectable()
export class TelegramUpdateService {
  constructor(
    private readonly database: LocalDatabaseService,
    private readonly telegramService: TelegramService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async notifyPickupDueOrders() {
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const orders = this.database.all<PickupDueOrder>(
      `SELECT * FROM orders
       WHERE pickupDate >= ? AND pickupDate <= ? AND status IN ('ready', 'in_progress') AND isTelegramNotified = 0
       ORDER BY pickupDate ASC
       LIMIT 30`,
      [now.toISOString(), end.toISOString()],
    );

    for (const order of orders) {
      await this.telegramService.sendPickupDue(order.telegramPhone || order.phone, {
        customerName: order.customerName,
        orderText: order.orderText,
        pickupDate: new Date(order.pickupDate),
        totalAmount: order.totalAmount,
        prepaidAmount: order.prepaidAmount,
        debtAmount: order.debtAmount,
        note: order.note,
      });
      this.database.run('UPDATE orders SET isTelegramNotified = 1, updatedAt = ? WHERE id = ?', [new Date().toISOString(), order.id]);
    }

    await this.telegramService.notifyAdminsImportantAlerts();
  }
}
