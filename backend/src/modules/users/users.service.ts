import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { sanitizeImageUrl } from '../../common/image-url';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';
import { UserRole } from './schemas/user.schema';

export type LocalUser = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  username: string | null;
  password?: string;
  role: UserRole;
  avatarUrl: string;
  mustChangePassword: number;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = Omit<LocalUser, 'password'>;

@Injectable()
export class UsersService {
  constructor(private readonly database: LocalDatabaseService) {}

  findByLogin(login: string) {
    const value = login.trim();
    const isEmail = value.includes('@');
    const looksLikePhone = /^\+?\d/.test(value);
    if (isEmail) {
      return this.database.get<LocalUser>('SELECT * FROM users WHERE lower(email) = ? LIMIT 1', [value.toLowerCase()]);
    }
    if (looksLikePhone) {
      const phone = normalizePhone(value);
      return this.database.get<LocalUser>('SELECT * FROM users WHERE phone = ? LIMIT 1', [phone]);
    }
    return this.database.get<LocalUser>('SELECT * FROM users WHERE lower(username) = ? LIMIT 1', [value.toLowerCase()]);
  }

  findById(id: string) {
    const user = this.database.get<LocalUser>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return user ? this.withoutPassword(user) : null;
  }

  async updateProfile(id: string, body: { fullName?: string; phone?: string; email?: string; avatarUrl?: string }) {
    const current = this.database.get<LocalUser>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (!current) throw new NotFoundException('User not found');

    const next = {
      fullName: body.fullName || current.fullName,
      phone: body.phone ? normalizePhone(body.phone) : current.phone,
      email: body.email ? body.email.toLowerCase() : current.email,
      avatarUrl: body.avatarUrl === undefined ? current.avatarUrl : sanitizeImageUrl(body.avatarUrl, 'Profil rasmi') || '',
      updatedAt: new Date().toISOString(),
    };

    try {
      this.database.run(
        `UPDATE users SET fullName = ?, phone = ?, email = ?, avatarUrl = ?, updatedAt = ? WHERE id = ?`,
        [next.fullName, next.phone, next.email, next.avatarUrl, next.updatedAt, id],
      );
    } catch {
      throw new BadRequestException('Telefon yoki email avval ro‘yxatdan o‘tgan');
    }

    const user = this.database.get<LocalUser>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    return this.withoutPassword(user!);
  }

  async changePassword(id: string, body: { currentPassword: string; newPassword: string }) {
    const user = this.database.get<LocalUser>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (!user) throw new NotFoundException('User not found');
    if (!user.password || !(await bcrypt.compare(body.currentPassword, user.password))) {
      throw new BadRequestException('Joriy parol noto‘g‘ri');
    }

    this.database.run('UPDATE users SET password = ?, mustChangePassword = 0, updatedAt = ? WHERE id = ?', [
      await bcrypt.hash(body.newPassword, 10),
      new Date().toISOString(),
      id,
    ]);
    return { changed: true };
  }

  async upsertAdmin(input: { fullName: string; email: string; phone: string; password: string; username: string }) {
    const now = new Date().toISOString();
    const email = input.email.toLowerCase();
    const phone = normalizePhone(input.phone);
    const password = await bcrypt.hash(input.password, 10);
    const existing = this.findAdmin();

    if (existing) {
      this.database.run(
        `UPDATE users SET fullName = ?, phone = ?, email = ?, password = ?, role = 'admin', updatedAt = ?, username = ?, mustChangePassword = 1 WHERE id = ?`,
        [input.fullName, phone, email, password, now, input.username, existing.id],
      );
      return this.findById(existing.id);
    }

    const id = this.database.createId();
    this.database.run(
      `INSERT INTO users (id, fullName, phone, email, password, role, avatarUrl, createdAt, updatedAt, username, mustChangePassword)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
      [id, input.fullName, phone, email, password, 'admin', now, now, input.username, 1],
    );
    return this.findById(id);
  }

  findAdmin() {
    return this.database.get<LocalUser>('SELECT * FROM users WHERE role = ? ORDER BY createdAt ASC LIMIT 1', ['admin']);
  }

  async resetPasswordForUserId(id: string, newPassword: string) {
    const user = this.database.get<LocalUser>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (!user) throw new NotFoundException('User not found');
    const hash = await bcrypt.hash(newPassword, 10);
    this.database.run('UPDATE users SET password = ?, updatedAt = ?, mustChangePassword = ? WHERE id = ?', [hash, new Date().toISOString(), 1, id]);
    return this.findById(id);
  }

  private withoutPassword(user: LocalUser): PublicUser {
    const { password: _password, ...publicUser } = user;
    return publicUser;
  }
}
