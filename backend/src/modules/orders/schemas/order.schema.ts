export type OrderStatus = 'new' | 'in_progress' | 'ready' | 'picked_up' | 'cancelled';
export type DebtPaymentType = 'cash' | 'card' | 'click' | 'payme';

export class DebtPayment {
  amount: number;
  paymentType: DebtPaymentType;
  paidAt: Date;
  createdBy?: string;
}

export class Order {
  id?: string;
  _id?: string;
  customerName: string;
  phone: string;
  telegramPhone: string;
  orderText: string;
  totalAmount: number;
  prepaidAmount: number;
  debtAmount: number;
  pickupDate: Date;
  status: OrderStatus;
  note: string;
  isTelegramNotified: boolean;
  payments: DebtPayment[];
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type OrderDocument = Order;
