import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { sanitizeImageUrl } from '../../common/image-url';
import { normalizePhone } from '../../common/phone';
import { LocalDatabaseService } from '../../local-db/local-database.service';

export type LocalUser = {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  password?: string;
  role: string;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class UsersService {
  constructor(private readonly database: LocalDatabaseService) {}

  findByLogin(login: string) {
    const isEmail = login.includes('@');
    const value = isEmail ? login.toLowerCase() : normalizePhone(login);
    return this.database.get<LocalUser>(`SELECT * FROM users WHERE ${isEmail ? 'email' : 'phone'} = ? LIMIT 1`, [value]);
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

    this.database.run('UPDATE users SET password = ?, updatedAt = ? WHERE id = ?', [
      await bcrypt.hash(body.newPassword, 10),
      new Date().toISOString(),
      id,
    ]);
    return { changed: true };
  }

  async upsertAdmin(input: { fullName: string; email: string; phone: string; password: string; role?: string }) {
    const now = new Date().toISOString();
    const email = input.email.toLowerCase();
    const phone = normalizePhone(input.phone);
    const password = await bcrypt.hash(input.password, 10);
    const existing = this.database.get<LocalUser>('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

    if (existing) {
      this.database.run(
        `UPDATE users SET fullName = ?, phone = ?, password = ?, role = ?, updatedAt = ? WHERE id = ?`,
        [input.fullName, phone, password, input.role || 'admin', now, existing.id],
      );
      return this.findById(existing.id);
    }

    const id = this.database.createId();
    this.database.run(
      `INSERT INTO users (id, fullName, phone, email, password, role, avatarUrl, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
      [id, input.fullName, phone, email, password, input.role || 'admin', now, now],
    );
    return this.findById(id);
  }

  private withoutPassword(user: LocalUser) {
    const { password: _password, ...publicUser } = user;
    return publicUser;
  }
}
