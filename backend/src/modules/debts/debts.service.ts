import { Injectable } from '@nestjs/common';
import { escapeRegex } from '../../common/escape-regex';
import { LocalDatabaseService } from '../../local-db/local-database.service';

export type DebtListItem = Record<string, unknown> & {
  _id: unknown;
  debtSource: 'flower' | 'gift';
  sourceLabel: string;
  title: string;
  totalAmount: number;
  paidAmount: number;
  debtAmount: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type DebtRow = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DebtsService {
  constructor(private readonly database: LocalDatabaseService) {}

  async findAll(query: { status?: 'active' | 'paid'; search?: string; source?: 'all' | 'flower' | 'gift' }): Promise<DebtListItem[]> {
    const source = query.source || 'all';
    const orders = source === 'gift' ? [] : this.findOrderDebts(query);
    const sales = source === 'flower' ? [] : this.findSaleDebts(query);

    return [...orders, ...sales].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
  }

  async stats() {
    const orderActive = this.scalar('SELECT COUNT(*) FROM orders WHERE debtAmount > 0 AND status != ?', ['cancelled']);
    const orderPaid = this.scalar("SELECT COUNT(*) FROM orders WHERE debtAmount = 0 AND payments != '[]'");
    const flowersDebt = this.scalar('SELECT COALESCE(SUM(debtAmount), 0) FROM orders WHERE debtAmount > 0 AND status != ?', ['cancelled']);
    const saleActive = this.scalar('SELECT COUNT(*) FROM sales WHERE debtAmount > 0');
    const salePaid = this.scalar("SELECT COUNT(*) FROM sales WHERE debtAmount = 0 AND payments != '[]'");
    const giftsDebt = this.scalar('SELECT COALESCE(SUM(debtAmount), 0) FROM sales WHERE debtAmount > 0');

    return {
      active: orderActive + saleActive,
      paid: orderPaid + salePaid,
      totalDebt: flowersDebt + giftsDebt,
      flowersDebt,
      giftsDebt,
    };
  }

  private findOrderDebts(query: { status?: 'active' | 'paid'; search?: string }): DebtListItem[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.status === 'paid') {
      clauses.push("debtAmount = 0 AND payments != '[]'");
    } else {
      clauses.push('debtAmount > 0 AND status != ?');
      params.push('cancelled');
    }

    if (query.search) {
      const search = this.like(query.search);
      clauses.push(`(customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR telegramPhone LIKE ? ESCAPE '\\' OR orderText LIKE ? ESCAPE '\\')`);
      params.push(search, search, search, search);
    }

    return this.database
      .all<DebtRow & { orderText: string; prepaidAmount: number; totalAmount: number; debtAmount: number }>(
        `SELECT * FROM orders WHERE ${clauses.join(' AND ')} ORDER BY updatedAt DESC, createdAt DESC`,
        params,
      )
      .map((order) => ({
        ...order,
        _id: order.id,
        createdAt: new Date(order.createdAt),
        updatedAt: new Date(order.updatedAt),
        debtSource: 'flower',
        sourceLabel: 'Gul buyurtmasi',
        title: order.orderText,
        paidAmount: order.prepaidAmount,
        totalAmount: order.totalAmount,
      }));
  }

  private findSaleDebts(query: { status?: 'active' | 'paid'; search?: string }): DebtListItem[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.status === 'paid') {
      clauses.push("debtAmount = 0 AND payments != '[]'");
    } else {
      clauses.push('debtAmount > 0');
    }

    if (query.search) {
      const search = this.like(query.search);
      clauses.push(`(customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR telegramPhone LIKE ? ESCAPE '\\' OR productName LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
      params.push(search, search, search, search, search);
    }

    return this.database
      .all<DebtRow & { productName: string; amount: number; paidAmount: number; debtAmount: number; telegramPhone: string }>(
        `SELECT * FROM sales WHERE ${clauses.join(' AND ')} ORDER BY updatedAt DESC, createdAt DESC`,
        params,
      )
      .map((sale) => ({
        ...sale,
        _id: sale.id,
        createdAt: new Date(sale.createdAt),
        updatedAt: new Date(sale.updatedAt),
        debtSource: 'gift',
        sourceLabel: 'Sovga/tovar',
        title: sale.productName,
        totalAmount: sale.amount,
        status: sale.debtAmount > 0 ? 'debt' : 'paid',
        telegramPhone: sale.telegramPhone || '',
        pickupDate: null,
      }));
  }

  private scalar(sql: string, params: Array<string | number> = []) {
    const row = this.database.get<Record<string, number>>(sql, params);
    return Number(row?.[Object.keys(row)[0]] || 0);
  }

  private like(value: string) {
    return `%${escapeRegex(value.trim()).replace(/[%_]/g, '\\$&')}%`;
  }
}
