export type PaymentType = 'cash' | 'card' | 'click' | 'payme' | 'debt';
export type SaleDebtPaymentType = 'cash' | 'card' | 'click' | 'payme';

export class SaleDebtPayment {
  amount: number;
  paymentType: SaleDebtPaymentType;
  paidAt: Date;
  createdBy?: string;
}

export class Sale {
  id?: string;
  _id?: string;
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
  payments: SaleDebtPayment[];
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type SaleDocument = Sale;
