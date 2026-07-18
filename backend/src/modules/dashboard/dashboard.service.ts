import { Injectable } from '@nestjs/common';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { Order } from '../orders/schemas/order.schema';

type DashboardStats = {
  totalTrade: number;
  tradePeriods: {
    daily: number;
    weekly: number;
    monthly: number;
    total: number;
  };
  flowerRevenue: number;
  giftRevenue: number;
  debtBreakdown: {
    flowers: number;
    gifts: number;
    total: number;
  };
  todaySales: number;
  todayProfit: number;
  todayPayments: Record<string, number>;
  totalDebt: number;
  totalOrders: number;
  todayOrders: number;
  pickupToday: number;
  upcomingOrders: number;
  readyOrders: number;
  debtOrders: number;
  overdueOrders: number;
};

type DashboardCharts = {
  weeklySales: Array<{ date: string; amount: number; profit: number }>;
  paymentTypes: Array<{ name: string; value: number }>;
  orderStatuses: Array<{ name: string; value: number }>;
};

export type DashboardResponse = {
  stats: DashboardStats;
  charts: DashboardCharts;
  pickupTodayOrders: Order[];
  upcomingOrders: Order[];
  readyOrders: Order[];
  debtOrders: Order[];
  overdueOrders: Order[];
};

type LocalOrderRow = Record<string, unknown> & {
  id: string;
  pickupDate: string;
  isTelegramNotified: number;
  payments: string;
  createdAt: string;
  updatedAt: string;
};

const PICKUP_SOON_HOURS = 24;

function dayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function weekBounds(date = new Date()) {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function monthBounds(date = new Date()) {
  const start = new Date(date);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(start.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date;
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: LocalDatabaseService) {}

  async overview(): Promise<DashboardResponse> {
    const now = new Date();
    const today = dayBounds(now);
    const week = weekBounds(now);
    const month = monthBounds(now);
    const soonUntil = addHours(now, PICKUP_SOON_HOURS);

    const flowerGross = this.scalar("SELECT COALESCE(SUM(totalAmount), 0) FROM orders WHERE status != 'cancelled'");
    const flowerPaid = this.scalar("SELECT COALESCE(SUM(totalAmount - debtAmount), 0) FROM orders WHERE status != 'cancelled'");
    const giftGross = this.scalar('SELECT COALESCE(SUM(amount), 0) FROM sales');
    const giftPaid = this.scalar('SELECT COALESCE(SUM(paidAmount), 0) FROM sales');
    const flowerDebt = this.scalar("SELECT COALESCE(SUM(debtAmount), 0) FROM orders WHERE debtAmount > 0 AND status != 'cancelled'");
    const giftDebt = this.scalar('SELECT COALESCE(SUM(debtAmount), 0) FROM sales WHERE debtAmount > 0');

    const todaySales = this.database.get<{ amount: number; profit: number }>(
      'SELECT COALESCE(SUM(amount), 0) as amount, COALESCE(SUM(profit), 0) as profit FROM sales WHERE createdAt >= ? AND createdAt <= ?',
      [today.start.toISOString(), today.end.toISOString()],
    ) || { amount: 0, profit: 0 };

    const todayPayments = this.database
      .all<{ _id: string; value: number }>(
        'SELECT paymentType as _id, COALESCE(SUM(amount), 0) as value FROM sales WHERE createdAt >= ? AND createdAt <= ? GROUP BY paymentType',
        [today.start.toISOString(), today.end.toISOString()],
      )
      .reduce<Record<string, number>>((acc, item) => {
        acc[item._id] = item.value;
        return acc;
      }, {});

    const stats = {
      totalTrade: flowerGross + giftGross,
      tradePeriods: {
        daily: this.tradeTotal(today.start, today.end),
        weekly: this.tradeTotal(week.start, week.end),
        monthly: this.tradeTotal(month.start, month.end),
        total: flowerGross + giftGross,
      },
      flowerRevenue: flowerPaid,
      giftRevenue: giftPaid,
      debtBreakdown: {
        flowers: flowerDebt,
        gifts: giftDebt,
        total: flowerDebt + giftDebt,
      },
      todaySales: Number(todaySales.amount || 0),
      todayProfit: Number(todaySales.profit || 0),
      todayPayments,
      totalDebt: flowerDebt + giftDebt,
      totalOrders: this.scalar("SELECT COUNT(*) FROM orders WHERE status != 'cancelled'"),
      todayOrders: this.scalar('SELECT COUNT(*) FROM orders WHERE createdAt >= ? AND createdAt <= ?', [today.start.toISOString(), today.end.toISOString()]),
      pickupToday: this.scalar("SELECT COUNT(*) FROM orders WHERE pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')", [today.start.toISOString(), today.end.toISOString()]),
      upcomingOrders: this.scalar("SELECT COUNT(*) FROM orders WHERE pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')", [now.toISOString(), soonUntil.toISOString()]),
      readyOrders: this.scalar("SELECT COUNT(*) FROM orders WHERE status = 'ready'"),
      debtOrders: this.scalar("SELECT COUNT(*) FROM orders WHERE debtAmount > 0 AND status != 'cancelled'"),
      overdueOrders: this.scalar("SELECT COUNT(*) FROM orders WHERE pickupDate < ? AND status NOT IN ('picked_up', 'cancelled')", [now.toISOString()]),
    };

    return {
      stats,
      charts: {
        weeklySales: this.database.all<{ date: string; amount: number; profit: number }>(
          `SELECT strftime('%Y-%m-%d', createdAt) as date, COALESCE(SUM(amount), 0) as amount, COALESCE(SUM(profit), 0) as profit
           FROM sales
           WHERE createdAt >= ?
           GROUP BY strftime('%Y-%m-%d', createdAt)
           ORDER BY date ASC`,
          [daysAgo(6).toISOString()],
        ),
        paymentTypes: this.database.all<{ name: string; value: number }>(
          'SELECT paymentType as name, COALESCE(SUM(amount), 0) as value FROM sales GROUP BY paymentType ORDER BY paymentType',
        ),
        orderStatuses: this.database.all<{ name: string; value: number }>(
          'SELECT status as name, COUNT(*) as value FROM orders GROUP BY status ORDER BY status',
        ),
      },
      pickupTodayOrders: this.findCompact(
        "pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')",
        [today.start.toISOString(), today.end.toISOString()],
        'pickupDate ASC',
      ),
      upcomingOrders: this.findCompact(
        "pickupDate >= ? AND pickupDate <= ? AND status NOT IN ('picked_up', 'cancelled')",
        [now.toISOString(), soonUntil.toISOString()],
        'pickupDate ASC',
      ),
      readyOrders: this.findCompact("status = 'ready'", [], 'updatedAt DESC'),
      debtOrders: this.findCompact("debtAmount > 0 AND status != 'cancelled'", [], 'debtAmount DESC, pickupDate ASC'),
      overdueOrders: this.findCompact("pickupDate < ? AND status NOT IN ('picked_up', 'cancelled')", [now.toISOString()], 'pickupDate ASC'),
    };
  }

  private findCompact(where: string, params: Array<string | number>, orderBy: string): Order[] {
    return this.database
      .all<LocalOrderRow>(
        `SELECT customerName, phone, telegramPhone, orderText, totalAmount, prepaidAmount, debtAmount, pickupDate, status, isTelegramNotified, createdAt, updatedAt, note, id, payments
         FROM orders
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT 10`,
        params,
      )
      .map((order) => ({
        ...order,
        _id: order.id,
        pickupDate: new Date(order.pickupDate),
        createdAt: new Date(order.createdAt),
        updatedAt: new Date(order.updatedAt),
        isTelegramNotified: Boolean(order.isTelegramNotified),
        payments: this.parseJson(order.payments),
      })) as unknown as Order[];
  }

  private tradeTotal(start: Date, end: Date): number {
    const params = [start.toISOString(), end.toISOString()];
    const orders = this.scalar(
      "SELECT COALESCE(SUM(totalAmount), 0) FROM orders WHERE status != 'cancelled' AND createdAt >= ? AND createdAt <= ?",
      params,
    );
    const sales = this.scalar('SELECT COALESCE(SUM(amount), 0) FROM sales WHERE createdAt >= ? AND createdAt <= ?', params);
    return orders + sales;
  }

  private scalar(sql: string, params: Array<string | number> = []) {
    const row = this.database.get<Record<string, number>>(sql, params);
    return Number(row?.[Object.keys(row)[0]] || 0);
  }

  private parseJson(value: unknown) {
    if (typeof value !== 'string') return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
}
