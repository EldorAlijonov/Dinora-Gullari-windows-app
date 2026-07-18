export class User {
  id?: string;
  _id?: string;
  fullName: string;
  phone: string;
  email: string;
  password: string;
  role: string;
  avatarUrl: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = User;
