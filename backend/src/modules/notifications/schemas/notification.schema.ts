export type NotificationStatus = 'sent' | 'failed';

export class Notification {
  id?: string;
  _id?: string;
  phone: string;
  type: string;
  message: string;
  status: NotificationStatus;
  sentAt?: Date;
  resolvedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationDocument = Notification;
