import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { LocalDatabaseService } from '../local-db/local-database.service';
import { OrderStatus } from '../modules/orders/schemas/order.schema';
import { PaymentType } from '../modules/sales/schemas/sale.schema';

function loadLocalEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function daysAgo(days: number, hour = 10) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, Math.floor(Math.random() * 50), 0, 0);
  return date;
}

function phone(index: number) {
  return `+99890${String(1000000 + index).slice(1)}`;
}

const names = ['Abdusamad', 'Eldor Alijonov', 'Dinora', 'Madina', 'Aziza', 'Jamshid', 'Sardor', 'Nilufar'];
const flowers = ['Atirgul buketi', 'Piona gul dasta', 'Lola guldasta', 'Orkideya kompozitsiya'];
const products = ['Atir', 'Shokolad', 'Ayiqcha', 'Sovga qutisi', 'Sharlar', 'Parfyum'];
const statuses: OrderStatus[] = ['new', 'in_progress', 'ready', 'picked_up', 'cancelled'];
const payments: PaymentType[] = ['cash', 'card', 'click', 'payme', 'debt'];

async function seed() {
  loadLocalEnv();
  process.env.LOCAL_DATABASE_ENABLED = 'true';
  const database = new LocalDatabaseService();
  await database.open();

  const now = new Date();
  const batchId = `demo-${now.toISOString()}`;
  const createdBy = 'demo';

  for (let index = 0; index < 125; index += 1) {
    const amount = 80000 + (index % 12) * 25000;
    const prepaidAmount = index % 4 === 0 ? Math.floor(amount * 0.45) : amount;
    const createdAt = daysAgo(index % 45, 9 + (index % 9));
    const pickupDate = new Date(createdAt);
    pickupDate.setDate(pickupDate.getDate() + (index % 7));

    database.run(
      `INSERT INTO orders (id, customerName, phone, telegramPhone, orderText, totalAmount, prepaidAmount, debtAmount, pickupDate, status, note, isTelegramNotified, payments, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      [
        database.createId(),
        names[index % names.length],
        phone(index),
        phone(index),
        `${flowers[index % flowers.length]} - demo test ${index + 1}`,
        amount,
        prepaidAmount,
        Math.max(amount - prepaidAmount, 0),
        pickupDate.toISOString(),
        statuses[index % statuses.length],
        batchId,
        index % 3 === 0 ? 1 : 0,
        createdBy,
        createdAt.toISOString(),
        createdAt.toISOString(),
      ],
    );
  }

  for (let index = 0; index < 35; index += 1) {
    const amount = 50000 + (index % 10) * 20000;
    const paidAmount = index % 5 === 0 ? Math.floor(amount * 0.5) : amount;
    const createdAt = daysAgo(index % 35, 11 + (index % 7));

    database.run(
      `INSERT INTO sales (id, productName, customerName, phone, telegramPhone, amount, paidAmount, debtAmount, costPrice, profit, paymentType, note, payments, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      [
        database.createId(),
        `${products[index % products.length]} demo ${index + 1}`,
        names[(index + 4) % names.length],
        index % 3 === 0 ? '' : phone(300 + index),
        phone(300 + index),
        amount,
        paidAmount,
        Math.max(amount - paidAmount, 0),
        Math.floor(amount * 0.55),
        paidAmount,
        payments[index % payments.length],
        batchId,
        createdBy,
        createdAt.toISOString(),
        createdAt.toISOString(),
      ],
    );
  }

  database.onModuleDestroy();
  console.log('Demo data added: 125 orders, 35 gift/product sales');
  console.log(`Batch note: ${batchId}`);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
