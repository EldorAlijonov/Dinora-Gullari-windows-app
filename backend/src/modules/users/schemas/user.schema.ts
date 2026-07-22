export type UserRole = 'service' | 'admin';

export class User {
  id?: string;
  _id?: string;
  fullName: string;
  phone: string;
  email: string;
  username: string | null;
  password: string;
  role: UserRole;
  avatarUrl: string;
  mustChangePassword: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = User;
