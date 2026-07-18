import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { escapeRegex } from '../../common/escape-regex';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { GoogleSheetsService } from '../google-sheets/google-sheets.service';
import { SettingsService } from '../settings/settings.service';
import { TelegramService } from '../telegram/telegram.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { PaySaleDebtDto } from './dto/pay-sale-debt.dto';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { PaymentType, SaleDebtPayment } from './schemas/sale.schema';

type LocalSaleRow = {
  id: string;
  productName: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  amount: number;
  paidAmount: number;
  debtAmount: number;
  costPrice: number;
  profit: number;
  paymentType: PaymentType;
  note: string;
  payments: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalSale = Omit<LocalSaleRow, 'payments'> & {
  _id: string;
  payments: SaleDebtPayment[];
};

@Injectable()
export class SalesService {
  constructor(
    private readonly database: LocalDatabaseService,
    private readonly telegramService: TelegramService,
    private readonly settingsService: SettingsService,
    private readonly googleSheetsService: GoogleSheetsService,
  ) {}

  async findAll(query: { paymentType?: PaymentType; date?: string; dateFrom?: string; dateTo?: string; search?: string; page?: string; limit?: string }) {
    const { where, params } = this.buildFilter(query);
    const page = Math.max(Number(query.page || 0), 0);
    const limit = Math.min(Math.max(Number(query.limit || 0), 0), 100);

    if (page && limit) {
      const items = this.database
        .all<LocalSaleRow>(`SELECT * FROM sales ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [
          ...params,
          limit,
          (page - 1) * limit,
        ])
        .map((row) => this.mapSale(row));
      const total = Number(this.database.get<{ total: number }>(`SELECT COUNT(*) as total FROM sales ${where}`, params)?.total || 0);
      return { items, total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) };
    }

    return this.database.all<LocalSaleRow>(`SELECT * FROM sales ${where} ORDER BY createdAt DESC`, params).map((row) => this.mapSale(row));
  }

  async create(dto: CreateSaleDto, userId: string) {
    const paidAmount = Math.min(dto.paidAmount ?? dto.amount, dto.amount);
    const debtAmount = Math.max(dto.amount - paidAmount, 0);
    const settings = await this.settingsService.getSettings();
    if (settings.requirePhoneForDebtSales && debtAmount > 0 && !dto.phone) {
      throw new BadRequestException('Nasiya savdo uchun telefon raqam majburiy');
    }

    const now = new Date().toISOString();
    const id = this.database.createId();
    this.database.run(
      `INSERT INTO sales (id, productName, customerName, phone, telegramPhone, amount, paidAmount, debtAmount, costPrice, profit, paymentType, note, payments, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        dto.productName || 'Sovga/tovar',
        dto.customerName || '',
        dto.phone ? normalizePhone(dto.phone) : '',
        dto.telegramPhone ? normalizePhone(dto.telegramPhone) : '',
        dto.amount,
        paidAmount,
        debtAmount,
        dto.costPrice || 0,
        paidAmount,
        dto.paymentType,
        dto.note || '',
        '[]',
        userId,
        now,
        now,
      ],
    );

    const sale = await this.findOne(id);
    void this.telegramService.sendSaleCreated(sale.telegramPhone || sale.phone, this.telegramDetails(sale)).catch(() => undefined);
    void this.telegramService.notifyAdminsNewSale(sale as never).catch(() => undefined);
    void this.googleSheetsService.appendSaleCreated(sale as never).catch(() => undefined);
    return sale;
  }

  async update(id: string, dto: UpdateSaleDto) {
    const sale = await this.findOne(id);
    const amount = dto.amount ?? sale.amount;
    const paidAmount = Math.min(dto.paidAmount ?? sale.paidAmount, amount);
    const debtAmount = Math.max(amount - paidAmount, 0);
    const settings = await this.settingsService.getSettings();
    if (settings.requirePhoneForDebtSales && debtAmount > 0 && !(dto.phone || sale.phone)) {
      throw new BadRequestException('Nasiya savdo uchun telefon raqam majburiy');
    }

    this.database.run(
      `UPDATE sales SET productName = ?, customerName = ?, phone = ?, telegramPhone = ?, amount = ?, paidAmount = ?, debtAmount = ?, costPrice = ?, profit = ?, paymentType = ?, note = ?, updatedAt = ? WHERE id = ?`,
      [
        dto.productName ?? sale.productName,
        dto.customerName ?? sale.customerName,
        dto.phone ? normalizePhone(dto.phone) : sale.phone,
        Object.prototype.hasOwnProperty.call(dto, 'telegramPhone')
          ? dto.telegramPhone
            ? normalizePhone(dto.telegramPhone)
            : ''
          : sale.telegramPhone,
        amount,
        paidAmount,
        debtAmount,
        dto.costPrice ?? sale.costPrice ?? 0,
        paidAmount,
        dto.paymentType ?? sale.paymentType,
        dto.note ?? sale.note,
        new Date().toISOString(),
        id,
      ],
    );
    return this.findOne(id);
  }

  async payDebt(id: string, dto: PaySaleDebtDto, userId: string) {
    const sale = await this.findOne(id);
    if (sale.debtAmount <= 0) throw new BadRequestException('Ushbu tovar sotuvida qarz mavjud emas');
    if (dto.amount > sale.debtAmount) throw new BadRequestException('Tolov qolgan qarzdan katta bolishi mumkin emas');

    const payments = [
      ...sale.payments,
      { amount: dto.amount, paymentType: dto.paymentType, paidAt: new Date(), createdBy: userId },
    ];
    const paidAmount = sale.paidAmount + dto.amount;

    this.database.run('UPDATE sales SET paidAmount = ?, debtAmount = ?, profit = ?, payments = ?, updatedAt = ? WHERE id = ?', [
      paidAmount,
      Math.max(sale.amount - paidAmount, 0),
      paidAmount,
      JSON.stringify(payments),
      new Date().toISOString(),
      id,
    ]);

    const saved = await this.findOne(id);
    void this.telegramService.sendSaleDebtPaymentReceived(saved.telegramPhone || saved.phone, this.telegramDetails(saved), dto.amount).catch(() => undefined);
    void this.telegramService.notifyAdminsDebtPayment('gift', saved as never, dto.amount).catch(() => undefined);
    return saved;
  }

  async sendDebtReminder(id: string) {
    const sale = await this.findOne(id);
    if (sale.debtAmount <= 0) throw new BadRequestException('Ushbu tovar sotuvida qarz mavjud emas');
    return this.telegramService.sendSaleDebtReminder(sale.telegramPhone || sale.phone, this.telegramDetails(sale));
  }

  async remove(id: string, userId?: string) {
    const sale = await this.findOne(id);
    await this.archiveSale(sale, userId);
    this.database.run('DELETE FROM sales WHERE id = ?', [id]);
    return { deleted: true };
  }

  async bulkRemove(dto: BulkDeleteDto, userId?: string) {
    const { where, params } = this.bulkDeleteFilter(dto);
    const sales = this.database.all<LocalSaleRow>(`SELECT * FROM sales ${where}`, params).map((row) => this.mapSale(row));
    for (const sale of sales) {
      await this.archiveSale(sale, userId);
      this.database.run('DELETE FROM sales WHERE id = ?', [sale.id]);
    }
    return { deleted: sales.length };
  }

  private async findOne(id: string) {
    const sale = this.database.get<LocalSaleRow>('SELECT * FROM sales WHERE id = ? LIMIT 1', [id]);
    if (!sale) throw new NotFoundException('Sale not found');
    return this.mapSale(sale);
  }

  private buildFilter(query: { paymentType?: PaymentType; date?: string; dateFrom?: string; dateTo?: string; search?: string }) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.paymentType) {
      clauses.push('paymentType = ?');
      params.push(query.paymentType);
    }
    if (query.search) {
      const search = `%${escapeRegex(query.search.trim()).replace(/[%_]/g, '\\$&')}%`;
      clauses.push(`(productName LIKE ? ESCAPE '\\' OR customerName LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR telegramPhone LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`);
      params.push(search, search, search, search, search);
    }
    if (query.date) {
      const { start, end } = this.dayRange(new Date(query.date));
      clauses.push('createdAt >= ? AND createdAt < ?');
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

  private async archiveSale(sale: LocalSale, userId?: string) {
    const now = new Date().toISOString();
    this.database.run(
      `INSERT INTO deleted_records (id, collectionName, recordId, record, deletedBy, deletedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.database.createId(), 'sales', sale.id, JSON.stringify(sale), userId || null, now, now, now],
    );
    void this.googleSheetsService.markSaleDeleted(sale as never, new Date(now)).catch(() => undefined);
  }

  private mapSale(row: LocalSaleRow): LocalSale {
    return { ...row, _id: row.id, payments: this.parsePayments(row.payments) };
  }

  private parsePayments(value: string): SaleDebtPayment[] {
    try {
      return JSON.parse(value || '[]').map((payment: SaleDebtPayment) => ({ ...payment, paidAt: new Date(payment.paidAt) }));
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

  private telegramDetails(sale: LocalSale) {
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
}
