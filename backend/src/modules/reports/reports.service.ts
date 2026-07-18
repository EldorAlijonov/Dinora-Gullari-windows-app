import { Injectable } from '@nestjs/common';
import { LocalDatabaseService } from '../../local-db/local-database.service';

export type ProfitGroupReport = {
  _id: string;
  amount: number;
  profit: number;
};

export type PaymentTypeReport = {
  _id: string;
  amount: number;
};

type TopDebtorOrder = {
  _id: unknown;
  customerName: string;
  phone: string;
  telegramPhone?: string;
  orderText: string;
  debtAmount: number;
};

export type TopDebtorReport = TopDebtorOrder & {
  remainingAmount: number;
};

export type ProfitableDayReport = {
  _id: string;
  profit: number;
};

export type ReportsOverview = {
  paymentTypes: PaymentTypeReport[];
  topDebtors: TopDebtorReport[];
  profitableDays: ProfitableDayReport[];
};

@Injectable()
export class ReportsService {
  constructor(private readonly database: LocalDatabaseService) {}

  daily(): Promise<ProfitGroupReport[]> {
    return Promise.resolve(this.groupProfit('%Y-%m-%d', 14));
  }

  weekly(): Promise<ProfitGroupReport[]> {
    return Promise.resolve(this.groupProfit('%Y-W%W', 12));
  }

  monthly(): Promise<ProfitGroupReport[]> {
    return Promise.resolve(this.groupProfit('%Y-%m', 12));
  }

  yearly(): Promise<ProfitGroupReport[]> {
    return Promise.resolve(this.groupProfit('%Y', 5));
  }

  async overview(): Promise<ReportsOverview> {
    const paymentTypes = this.database.all<PaymentTypeReport>(
      `SELECT paymentType as _id, COALESCE(SUM(amount), 0) as amount FROM sales GROUP BY paymentType ORDER BY paymentType`,
    );
    const topDebtors = this.database
      .all<TopDebtorOrder & { id: string }>(
        `SELECT id, customerName, phone, telegramPhone, orderText, debtAmount
         FROM orders
         WHERE debtAmount > 0 AND status != ?
         ORDER BY debtAmount DESC
         LIMIT 8`,
        ['cancelled'],
      )
      .map((order) => ({ ...order, _id: order.id, remainingAmount: order.debtAmount }));
    const profitableDays = this.database.all<ProfitableDayReport>(
      `SELECT strftime('%Y-%m-%d', createdAt) as _id, COALESCE(SUM(profit), 0) as profit
       FROM sales
       GROUP BY strftime('%Y-%m-%d', createdAt)
       ORDER BY profit DESC
       LIMIT 8`,
    );

    return { paymentTypes, topDebtors, profitableDays };
  }

  private groupProfit(format: string, limit: number): ProfitGroupReport[] {
    return this.database
      .all<ProfitGroupReport>(
        `SELECT * FROM (
           SELECT strftime(?, createdAt) as _id, COALESCE(SUM(amount), 0) as amount, COALESCE(SUM(profit), 0) as profit
           FROM sales
           GROUP BY strftime(?, createdAt)
           ORDER BY _id DESC
           LIMIT ?
         ) grouped
         ORDER BY _id ASC`,
        [format, format, limit],
      )
      .filter((row) => Boolean(row._id));
  }
}
