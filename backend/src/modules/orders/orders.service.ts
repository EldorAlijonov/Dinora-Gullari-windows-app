import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { escapeRegex } from '../../common/escape-regex';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { GoogleSheetsService } from '../google-sheets/google-sheets.service';
import { TelegramService } from '../telegram/telegram.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { PayOrderDebtDto } from './dto/pay-order-debt.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { DebtPayment, OrderStatus } from './schemas/order.schema';

type LocalOrderRow = {
  id: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  orderText: string;
  totalAmount: number;
  prepaidAmount: number;
  debtAmount: number;
  pickupDate: string;
  status: OrderStatus;
  note: string;
  isTelegramNotified: number;
  payments: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalOrder = Omit<LocalOrderRow, 'payments' | 'isTelegramNotified' | 'pickupDate'> & {
  _id: string;
  payments: DebtPayment[];
  isTelegramNotified: boolean;
  pickupDate: Date;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: LocalDatabaseService,
    private readonly telegramService: TelegramService,
    private readonly googleSheetsService: GoogleSheetsService,
  ) {}

  async findAll(query: { status?: OrderStatus; search?: string; date?: string; dateFrom?: string; dateTo?: string; page?: string; limit?: string; filter?: 'today' | 'pickup_today' | 'upcoming' | 'debt' | 'overdue' }) {
    const { where, params } = this.buildFilter(query);
    const page = Math.max(Number(query.page || 0), 0);
    const limit = Math.min(Math.max(Number(query.limit || 0), 0), 100);

    if (page && limit) {
      const items = this.database
        .all<LocalOrderRow>(`SELECT * FROM orders ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [
          ...params,
          limit,
          (page - 1) * limit,
        ])
        .map((row) => this.mapOrder(row));
      const total = Number(this.database.get<{ total: number }>(`SELECT COUNT(*) as total FROM orders ${where}`, params)?.total || 0);
      return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
    }

    return this.database.all<LocalOrderRow>(`SELECT * FROM orders ${where} ORDER BY createdAt DESC`, params).map((row) => this.mapOrder(row));
  }

  async findOne(id: string) {
    const order = this.findRow(id);
    if (!order) throw new NotFoundException('Order not found');
    return this.mapOrder(order);
  }

  async create(dto: CreateOrderDto, userId: string) {
    const now = new Date().toISOString();
    const id = this.database.createId();
    const totalAmount = Number(dto.totalAmount);
    const prepaidAmount = Number(dto.prepaidAmount || 0);
    const order = {
      id,
      customerName: dto.customerName,
      phone: normalizePhone(dto.phone),
      telegramPhone: normalizePhone(dto.telegramPhone),
      orderText: dto.orderText,
      totalAmount,
      prepaidAmount,
      debtAmount: Math.max(totalAmount - prepaidAmount, 0),
      pickupDate: new Date(dto.pickupDate).toISOString(),
      status: dto.status || 'new',
      note: dto.note || '',
      isTelegramNotified: 0,
      payments: '[]',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    this.database.run(
      `INSERT INTO orders (id, customerName, phone, telegramPhone, orderText, totalAmount, prepaidAmount, debtAmount, pickupDate, status, note, isTelegramNotified, payments, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        order.customerName,
        order.phone,
        order.telegramPhone,
        order.orderText,
        order.totalAmount,
        order.prepaidAmount,
        order.debtAmount,
        order.pickupDate,
        order.status,
        order.note,
        order.isTelegramNotified,
        order.payments,
        order.createdBy,
        order.createdAt,
        order.updatedAt,
      ],
    );

    const saved = await this.findOne(id);
    void this.telegramService.sendOrderAccepted(saved.telegramPhone || saved.phone, this.telegramDetails(saved)).catch(() => undefined);
    void this.telegramService.notifyAdminsNewOrder(saved as never).catch(() => undefined);
    void this.googleSheetsService.appendOrderCreated(saved as never).catch(() => undefined);
    return saved;
  }

  async update(id: string, dto: UpdateOrderDto) {
    const current = await this.findOne(id);
    const previousStatus = current.status;
    const totalAmount = dto.totalAmount ?? current.totalAmount;
    const prepaidAmount = dto.prepaidAmount ?? current.prepaidAmount;
    const status = dto.status ?? current.status;
    const isTelegramNotified = status === 'ready' ? 1 : current.isTelegramNotified ? 1 : 0;

    this.database.run(
      `UPDATE orders SET customerName = ?, phone = ?, telegramPhone = ?, orderText = ?, totalAmount = ?, prepaidAmount = ?, debtAmount = ?, pickupDate = ?, status = ?, note = ?, isTelegramNotified = ?, updatedAt = ? WHERE id = ?`,
      [
        dto.customerName ?? current.customerName,
        dto.phone ? normalizePhone(dto.phone) : current.phone,
        dto.telegramPhone ? normalizePhone(dto.telegramPhone) : current.telegramPhone,
        dto.orderText ?? current.orderText,
        totalAmount,
        prepaidAmount,
        Math.max(totalAmount - prepaidAmount, 0),
        dto.pickupDate ? new Date(dto.pickupDate).toISOString() : current.pickupDate.toISOString(),
        status,
        dto.note ?? current.note,
        isTelegramNotified,
        new Date().toISOString(),
        id,
      ],
    );

    const saved = await this.findOne(id);
    if (dto.status && dto.status !== 'new' && dto.status !== previousStatus) {
      void this.telegramService.sendOrderStatusChanged(saved.telegramPhone || saved.phone, dto.status, this.telegramDetails(saved)).catch(() => undefined);
    }
    return saved;
  }

  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.findOne(id);
    this.database.run('UPDATE orders SET status = ?, isTelegramNotified = ?, updatedAt = ? WHERE id = ?', [
      status,
      status === 'ready' ? 1 : order.isTelegramNotified ? 1 : 0,
      new Date().toISOString(),
      id,
    ]);

    const saved = await this.findOne(id);
    if (status !== 'new' && status !== order.status) {
      void this.telegramService.sendOrderStatusChanged(saved.telegramPhone || saved.phone, status, this.telegramDetails(saved)).catch(() => undefined);
    }
    return saved;
  }

  async payDebt(id: string, dto: PayOrderDebtDto, userId: string) {
    const order = await this.findOne(id);
    if (order.debtAmount <= 0) throw new BadRequestException('Ushbu buyurtmada qarz mavjud emas');
    if (dto.amount > order.debtAmount) throw new BadRequestException('Tolov qolgan qarzdan katta bolishi mumkin emas');

    const payments = [
      ...order.payments,
      { amount: dto.amount, paymentType: dto.paymentType, paidAt: new Date(), createdBy: userId },
    ];
    const prepaidAmount = order.prepaidAmount + dto.amount;

    this.database.run('UPDATE orders SET prepaidAmount = ?, debtAmount = ?, payments = ?, updatedAt = ? WHERE id = ?', [
      prepaidAmount,
      Math.max(order.totalAmount - prepaidAmount, 0),
      JSON.stringify(payments),
      new Date().toISOString(),
      id,
    ]);

    const saved = await this.findOne(id);
    void this.telegramService.sendDebtPaymentReceived(saved.telegramPhone || saved.phone, this.telegramDetails(saved), dto.amount).catch(() => undefined);
    void this.telegramService.notifyAdminsDebtPayment('flower', saved as never, dto.amount).catch(() => undefined);
    return saved;
  }

  async sendDebtReminder(id: string) {
    const order = await this.findOne(id);
    if (order.debtAmount <= 0) throw new BadRequestException('Ushbu buyurtmada qarz mavjud emas');
    return this.telegramService.sendDebtReminder(order.telegramPhone || order.phone, this.telegramDetails(order));
  }

  async remove(id: string, userId?: string) {
    const order = await this.findOne(id);
    await this.archiveOrder(order, userId);
    this.database.run('DELETE FROM orders WHERE id = ?', [id]);
    return { deleted: true };
  }

  async bulkRemove(dto: BulkDeleteDto, userId?: string) {
    const { where, params } = this.bulkDeleteFilter(dto);
    const orders = this.database.all<LocalOrderRow>(`SELECT * FROM orders ${where}`, params).map((row) => this.mapOrder(row));
    for (const order of orders) {
      await this.archiveOrder(order, userId);
      this.database.run('DELETE FROM orders WHERE id = ?', [order.id]);
    }
    return { deleted: orders.length };
  }

  private buildFilter(query: { status?: OrderStatus; search?: string; date?: string; dateFrom?: string; dateTo?: string; filter?: 'today' | 'pickup_today' | 'upcoming' | 'debt' | 'overdue' }) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    const now = new Date();

    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.search) {
      const search = `%${escapeRegex(query.search.trim()).replace(/[%_]/g, '\\$&')}%`;
      clauses.push(`(customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR telegramPhone LIKE ? ESCAPE '\\' OR orderText LIKE ? ESCAPE '\\')`);
      params.push(search, search, search, search);
    }
    if (query.date) {
      const { start, end } = this.dayRange(new Date(query.date));
      clauses.push('pickupDate >= ? AND pickupDate < ?');
      params.push(start, end);
    }
    if (query.dateFrom) {
      const start = new Date(query.dateFrom);
      start.setHours(0, 0, 0, 0);
      clauses.push('createdAt >= ?');
      params.push(start.toISOString());
    }
    if (query.dateTo) {
      const end = new Date(query.dateTo);
      end.setHours(23, 59, 59, 999);
      clauses.push('createdAt <= ?');
      params.push(end.toISOString());
    }
    if (query.filter === 'today') {
      const { start, end } = this.dayRange(now);
      clauses.push('createdAt >= ? AND createdAt <= ?');
      params.push(start, end);
    }
    if (query.filter === 'pickup_today') {
      const { start, end } = this.dayRange(now);
      clauses.push('pickupDate >= ? AND pickupDate <= ? AND status NOT IN (?, ?)');
      params.push(start, end, 'picked_up', 'cancelled');
    }
    if (query.filter === 'upcoming') {
      clauses.push('pickupDate >= ? AND pickupDate <= ? AND status NOT IN (?, ?)');
      params.push(now.toISOString(), new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), 'picked_up', 'cancelled');
    }
    if (query.filter === 'debt') {
      clauses.push('debtAmount > 0 AND status != ?');
      params.push('cancelled');
    }
    if (query.filter === 'overdue') {
      clauses.push('pickupDate < ? AND status NOT IN (?, ?)');
      params.push(now.toISOString(), 'picked_up', 'cancelled');
    }

    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private bulkDeleteFilter(dto: BulkDeleteDto) {
    if (dto.scope === 'selected') {
      const ids = dto.ids || [];
      if (ids.length === 0) throw new BadRequestException("O'chirish uchun yozuv tanlanmagan");
      return { where: `WHERE id IN (${ids.map(() => '?').join(', ')})`, params: ids };
    }
    const { start, end } = this.deleteDateRange(dto);
    return { where: 'WHERE createdAt >= ? AND createdAt <= ?', params: [start.toISOString(), end.toISOString()] };
  }

  private deleteDateRange(dto: BulkDeleteDto) {
    if (dto.scope === 'range') {
      if (!dto.dateFrom || !dto.dateTo) throw new BadRequestException('Boshlanish va tugash sanalarini tanlang');
      const start = new Date(dto.dateFrom);
      const end = new Date(dto.dateTo);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException("Sana noto'g'ri kiritilgan");
      if (start > end) throw new BadRequestException('Boshlanish sanasi tugash sanasidan keyin bolishi mumkin emas');
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }

    const anchor = dto.anchorDate ? new Date(dto.anchorDate) : new Date();
    if (Number.isNaN(anchor.getTime())) throw new BadRequestException("Sana noto'g'ri kiritilgan");
    const start = new Date(anchor);
    const end = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    if (dto.scope === 'week') {
      const day = start.getDay() || 7;
      start.setDate(start.getDate() - day + 1);
      end.setTime(start.getTime());
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    }
    if (dto.scope === 'month') {
      start.setDate(1);
      end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
    }
    return { start, end };
  }

  private async archiveOrder(order: LocalOrder, userId?: string) {
    const now = new Date().toISOString();
    this.database.run(
      `INSERT INTO deleted_records (id, collectionName, recordId, record, deletedBy, deletedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.database.createId(), 'orders', order.id, JSON.stringify(order), userId || null, now, now, now],
    );
    void this.googleSheetsService.markOrderDeleted(order as never, new Date(now)).catch(() => undefined);
  }

  private findRow(id: string) {
    return this.database.get<LocalOrderRow>('SELECT * FROM orders WHERE id = ? LIMIT 1', [id]);
  }

  private mapOrder(row: LocalOrderRow): LocalOrder {
    return {
      ...row,
      _id: row.id,
      pickupDate: new Date(row.pickupDate),
      isTelegramNotified: Boolean(row.isTelegramNotified),
      payments: this.parsePayments(row.payments),
    };
  }

  private parsePayments(value: string): DebtPayment[] {
    try {
      return JSON.parse(value || '[]').map((payment: DebtPayment) => ({ ...payment, paidAt: new Date(payment.paidAt) }));
    } catch {
      return [];
    }
  }

  private dayRange(date: Date) {
    const start = new Date(date);
    const end = new Date(start);
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 1);
    end.setHours(0, 0, 0, 0);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  private telegramDetails(order: LocalOrder) {
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
}
