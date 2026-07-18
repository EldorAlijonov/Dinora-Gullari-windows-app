export class TelegramUser {
  id?: string;
  _id?: string;
  chatId: string;
  phone: string;
  firstName?: string;
  username?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type TelegramUserDocument = TelegramUser;
