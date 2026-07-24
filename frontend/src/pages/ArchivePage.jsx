import { CalendarClock, CalendarDays, ChevronLeft, CreditCard, Eye, FileText, Gift, Phone, Search, Send, ShoppingBag, Trash2, UserRound, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmModal } from '../components/ui/ConfirmModal';
import { CopyableText } from '../components/ui/CopyableText';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { useBulkDeleteOrdersMutation, useBulkDeleteSalesMutation, useOrdersQuery, useSalesQuery, useSettingsQuery } from '../services/api';
import { getErrorMessage } from '../utils/errorMessage';
import { formatCurrency } from '../utils/formatCurrency';
import { formatDate } from '../utils/formatDate';

const periodOptions = [
  ['day', 'Kunlik'],
  ['week', 'Haftalik'],
  ['month', 'Oylik'],
  ['year', 'Yillik'],
];

const deleteScopeOptions = [
  ['selected', 'Tanlangan yozuvlar'],
  ['day', 'Bir kunlik'],
  ['week', 'Bir haftalik'],
  ['month', 'Bir oylik'],
  ['range', 'Tanlangan davr'],
];

const orderStatusLabels = {
  new: 'Yangi',
  in_progress: 'Jarayonda',
  ready: 'Tayyor',
  picked_up: 'Olib ketilgan',
  cancelled: 'Bekor qilingan',
};

const paymentTypeLabels = {
  cash: 'Naqd',
  card: 'Karta',
  click: 'Click',
  payme: 'Payme',
  debt: 'Qarz',
};

function inputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateRange(period, anchorValue) {
  const anchor = anchorValue ? new Date(anchorValue) : new Date();
  const start = new Date(anchor);
  const end = new Date(anchor);

  if (period === 'week') {
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 6);
  } else if (period === 'month') {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
  } else if (period === 'year') {
    start.setMonth(0, 1);
    end.setMonth(11, 31);
  }

  return { dateFrom: inputDate(start), dateTo: inputDate(end) };
}

function queryItems(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  return [];
}

export default function ArchivePage() {
  const navigate = useNavigate();
  const today = inputDate(new Date());
  const [period, setPeriod] = useState('day');
  const [anchorDate, setAnchorDate] = useState(today);
  const [search, setSearch] = useState('');
  const [deleteScope, setDeleteScope] = useState('selected');
  const [deleteDateFrom, setDeleteDateFrom] = useState(today);
  const [deleteDateTo, setDeleteDateTo] = useState(today);
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [viewingRow, setViewingRow] = useState(null);
  const [bulkDeleteOrders, orderDeleteState] = useBulkDeleteOrdersMutation();
  const [bulkDeleteSales, saleDeleteState] = useBulkDeleteSalesMutation();
  const range = useMemo(() => dateRange(period, anchorDate), [period, anchorDate]);
  const params = useMemo(() => ({ ...range, search: search || undefined }), [range, search]);
  const orders = useOrdersQuery(params);
  const sales = useSalesQuery(params);
  const { data: settingsData } = useSettingsQuery();
  const telegramEnabled = Boolean(settingsData?.telegramBotConfigured);

  const orderItems = queryItems(orders.data).map((item) => ({ type: 'order', createdAt: item.createdAt, item }));
  const saleItems = queryItems(sales.data).map((item) => ({ type: 'sale', createdAt: item.createdAt, item }));
  const items = [...orderItems, ...saleItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const totalAmount = items.reduce((sum, row) => sum + (row.type === 'order' ? row.item.totalAmount : row.item.amount), 0);
  const totalDebt = items.reduce((sum, row) => sum + (row.item.debtAmount || 0), 0);
  const selectedOrderIds = [...selectedRows].filter((key) => key.startsWith('order:')).map((key) => key.slice('order:'.length));
  const selectedSaleIds = [...selectedRows].filter((key) => key.startsWith('sale:')).map((key) => key.slice('sale:'.length));
  const allVisibleSelected = items.length > 0 && items.every((row) => selectedRows.has(rowKey(row)));
  const deleteLoading = orderDeleteState.isLoading || saleDeleteState.isLoading;
  const deleteLabel = deleteScopeOptions.find(([value]) => value === deleteScope)?.[1] || '';

  const toggleRow = (key) => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        items.forEach((row) => next.delete(rowKey(row)));
      } else {
        items.forEach((row) => next.add(rowKey(row)));
      }
      return next;
    });
  };

  const confirmDescription = deleteScope === 'selected'
    ? `${selectedRows.size} ta tanlangan yozuv o'chiriladi. Google Sheetsdagi qatorlar o'chmaydi, statusi "O'chirildi" bo'ladi.`
    : deleteScope === 'range'
      ? `Tanlangan davr (${deleteDateFrom} - ${deleteDateTo}) yozuvlari o'chiriladi. Google Sheetsdagi qatorlar o'chmaydi, statusi "O'chirildi" bo'ladi.`
    : `${deleteLabel} (${dateRange(deleteScope, anchorDate).dateFrom} - ${dateRange(deleteScope, anchorDate).dateTo}) yozuvlari o'chiriladi. Google Sheetsdagi qatorlar o'chmaydi, statusi "O'chirildi" bo'ladi.`;

  const handleBulkDelete = async () => {
    if (deleteScope === 'selected' && selectedRows.size === 0) {
      toast.error('O\'chirish uchun kamida bitta yozuv tanlang');
      return;
    }
    if (deleteScope === 'range' && (!deleteDateFrom || !deleteDateTo)) {
      toast.error('Boshlanish va tugash sanalarini tanlang');
      return;
    }
    if (deleteScope === 'range' && new Date(deleteDateFrom) > new Date(deleteDateTo)) {
      toast.error('Boshlanish sanasi tugash sanasidan keyin bo\'lishi mumkin emas');
      return;
    }
    setConfirmOpen(true);
  };

  const executeBulkDelete = async () => {
    const body = deleteScope === 'selected'
      ? { scope: 'selected' }
      : deleteScope === 'range'
        ? { scope: 'range', dateFrom: deleteDateFrom, dateTo: deleteDateTo }
      : { scope: deleteScope, anchorDate };

    try {
      const [ordersResult, salesResult] = await Promise.all([
        deleteScope === 'selected' && selectedOrderIds.length === 0
          ? Promise.resolve({ deleted: 0 })
          : bulkDeleteOrders(deleteScope === 'selected' ? { ...body, ids: selectedOrderIds } : body).unwrap(),
        deleteScope === 'selected' && selectedSaleIds.length === 0
          ? Promise.resolve({ deleted: 0 })
          : bulkDeleteSales(deleteScope === 'selected' ? { ...body, ids: selectedSaleIds } : body).unwrap(),
      ]);
      const deleted = (ordersResult.deleted || 0) + (salesResult.deleted || 0);
      setSelectedRows(new Set());
      setConfirmOpen(false);
      toast.success(`${deleted} ta yozuv o'chirildi`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Yozuvlarni o\'chirishda xatolik'));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Buyurtmalar tarixi"
        description="Gul buyurtmalari va sovg'a/tovar sotuvlarini kunlik, haftalik, oylik yoki yillik ko'ring."
        action={(
          <Button variant="secondary" onClick={() => navigate('/')}>
            <ChevronLeft className="h-4 w-4" />
            Dashboardga qaytish
          </Button>
        )}
      />

      <Card>
        <div className="grid gap-3 xl:grid-cols-[auto_180px_1fr] xl:items-center">
          <div className="flex flex-wrap gap-2">
            {periodOptions.map(([value, label]) => (
              <Button key={value} variant={period === value ? 'primary' : 'secondary'} onClick={() => setPeriod(value)}>
                <CalendarDays className="h-4 w-4" /> {label}
              </Button>
            ))}
          </div>
          <Input type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
          <Input
            placeholder="Mijoz, telefon, buyurtma yoki tovar nomi"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leftElement={<Search className="h-4 w-4 text-slate-500" />}
            rightElement={search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
                title="Qidiruvni tozalash"
                aria-label="Qidiruvni tozalash"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Summary label="Davr" value={`${range.dateFrom} - ${range.dateTo}`} />
          <Summary label="Yozuvlar" value={items.length} />
          <Summary label="Umumiy summa" value={formatCurrency(totalAmount)} />
          <Summary label="Qolgan qarz" value={formatCurrency(totalDebt)} danger />
        </div>
      </Card>

      <Card>
        <div className="grid gap-3 lg:grid-cols-[260px_1fr_auto] lg:items-end">
          <Select label="O'chirish turi" value={deleteScope} onChange={(event) => setDeleteScope(event.target.value)}>
            {deleteScopeOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          {deleteScope === 'range' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Boshlanish sanasi" type="date" value={deleteDateFrom} onChange={(event) => setDeleteDateFrom(event.target.value)} />
              <Input label="Tugash sanasi" type="date" value={deleteDateTo} onChange={(event) => setDeleteDateTo(event.target.value)} />
            </div>
          ) : (
            <p className="text-sm leading-6 text-slate-400">
              {deleteScope === 'selected'
                ? `Tanlangan: ${selectedRows.size} ta. Jadvaldan kerakli yozuvlarni belgilang.`
                : `${deleteLabel} o'chirish joriy tanlangan sana asosida ishlaydi: ${dateRange(deleteScope, anchorDate).dateFrom} - ${dateRange(deleteScope, anchorDate).dateTo}.`}
            </p>
          )}
          <Button variant="danger" loading={deleteLoading} onClick={handleBulkDelete}>
            <Trash2 className="h-4 w-4" /> O'chirish
          </Button>
        </div>
      </Card>

      <Card className="overflow-x-auto">
        {orders.isLoading || sales.isLoading ? (
          <div className="p-8 text-center text-slate-400">Yuklanmoqda...</div>
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <table className="w-full min-w-[1160px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="w-11 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="h-4 w-4 accent-rose-400"
                    aria-label="Barcha ko'rinayotgan yozuvlarni tanlash"
                  />
                </th>
                {['#', 'Turi', 'Sana', 'Mijoz', 'Telefon', 'Nomi', 'Umumiy', 'Qarz', 'Status', 'Amallar'].map((heading) => (
                  <th key={heading} className="px-3 py-3">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {items.map((row, index) => (
                <ArchiveRow
                  key={rowKey(row)}
                  row={row}
                  index={index}
                  selected={selectedRows.has(rowKey(row))}
                  onToggle={() => toggleRow(rowKey(row))}
                  onView={() => setViewingRow(row)}
                  telegramEnabled={telegramEnabled}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmModal
        open={confirmOpen}
        title="Yozuvlarni o'chirish"
        description={confirmDescription}
        confirmText="O'chirish"
        variant="danger"
        loading={deleteLoading}
        onClose={() => setConfirmOpen(false)}
        onConfirm={executeBulkDelete}
      />

      <ArchiveDetailsModal row={viewingRow} onClose={() => setViewingRow(null)} telegramEnabled={telegramEnabled} />
    </div>
  );
}

function ArchiveRow({ row, index, selected, onToggle, onView, telegramEnabled = false }) {
  const item = row.item;
  const isOrder = row.type === 'order';
  const name = isOrder ? item.customerName : item.customerName || '-';
  const phone = telegramEnabled ? item.phone || item.telegramPhone || '-' : item.phone || '-';
  const title = isOrder ? item.orderText : item.productName || 'Sovga/tovar';
  const amount = isOrder ? item.totalAmount : item.amount;
  const status = isOrder ? orderStatusLabels[item.status] || item.status : paymentTypeLabels[item.paymentType] || item.paymentType;

  return (
    <tr className="transition hover:bg-white/5">
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 accent-rose-400"
          aria-label="Yozuvni tanlash"
        />
      </td>
      <td className="px-3 py-3 font-bold text-slate-500">{index + 1}</td>
      <td className="px-3 py-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-bold ${isOrder ? 'border-rose-300/20 bg-rose-400/10 text-rose-100' : 'border-sky-300/20 bg-sky-400/10 text-sky-100'}`}>
          {isOrder ? <ShoppingBag className="h-3.5 w-3.5" /> : <Gift className="h-3.5 w-3.5" />}
          {isOrder ? 'Gul' : 'Sovga/tovar'}
        </span>
      </td>
      <td className="px-3 py-3 text-slate-400">{formatDate(item.createdAt)}</td>
      <td className="px-3 py-3 font-semibold text-slate-100">
        <CopyableText value={name} label="Mijoz ismini nusxalash" />
      </td>
      <td className="px-3 py-3 text-slate-300">
        <CopyableText value={phone} label="Telefon raqamni nusxalash" />
      </td>
      <td className="max-w-xs px-3 py-3 text-slate-300">
        <span className="line-clamp-2">{title}</span>
      </td>
      <td className="px-3 py-3 font-bold text-slate-100">{formatCurrency(amount)}</td>
      <td className="px-3 py-3 font-bold text-amber-200">{formatCurrency(item.debtAmount || 0)}</td>
      <td className="px-3 py-3 text-slate-300">{status}</td>
      <td className="px-3 py-3">
        <Button variant="secondary" onClick={onView} className="px-3" title="To'liq tavsilotlarni ko'rish" aria-label="To'liq tavsilotlarni ko'rish">
          <Eye className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

function ArchiveDetailsModal({ row, onClose, telegramEnabled = false }) {
  const item = row?.item;
  const isOrder = row?.type === 'order';
  const title = isOrder ? 'Gul buyurtmasi tavsilotlari' : "Sovga/tovar sotuv tavsilotlari";

  return (
    <Modal open={Boolean(row)} title={title} onClose={onClose} maxWidth="max-w-4xl">
      {item && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-white/10 bg-slate-950/30 p-4">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500">{isOrder ? 'Buyurtma' : 'Sotuv'}</p>
              <h3 className="mt-1 max-w-2xl break-words text-xl font-bold text-slate-100">
                {isOrder ? item.orderText || '-' : item.productName || 'Sovga/tovar'}
              </h3>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-bold ${isOrder ? 'border-rose-300/20 bg-rose-400/10 text-rose-100' : 'border-sky-300/20 bg-sky-400/10 text-sky-100'}`}>
              {isOrder ? <ShoppingBag className="h-4 w-4" /> : <Gift className="h-4 w-4" />}
              {isOrder ? orderStatusLabels[item.status] || item.status : paymentTypeLabels[item.paymentType] || item.paymentType}
            </span>
          </div>

          {isOrder ? <OrderArchiveDetails item={item} telegramEnabled={telegramEnabled} /> : <SaleArchiveDetails item={item} telegramEnabled={telegramEnabled} />}

          <PaymentHistory payments={item.payments || []} />
        </div>
      )}
    </Modal>
  );
}

function OrderArchiveDetails({ item, telegramEnabled = false }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <DetailCard icon={UserRound} label="Mijoz" value={item.customerName} copyable />
        <DetailCard icon={Phone} label="Aloqa telefoni" value={item.phone} copyable />
        {telegramEnabled && <DetailCard icon={Send} label="Telegram telefoni" value={item.telegramPhone || item.phone} copyable />}
        <DetailCard icon={CalendarClock} label="Yaratilgan sana" value={formatDate(item.createdAt)} />
        <DetailCard icon={CalendarClock} label="Olib ketish sanasi" value={formatDate(item.pickupDate)} />
        <DetailCard icon={CalendarClock} label="Yangilangan sana" value={formatDate(item.updatedAt)} />
        {telegramEnabled && <DetailCard icon={FileText} label="Telegram xabar" value={item.isTelegramNotified ? 'Yuborilgan' : 'Yuborilmagan'} />}
        <DetailCard icon={FileText} label="Yozuv ID" value={item._id || item.id} copyable />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <DetailCard icon={CreditCard} label="Umumiy summa" value={formatCurrency(item.totalAmount)} />
        <DetailCard icon={CreditCard} label="Oldindan to'lov" value={formatCurrency(item.prepaidAmount)} />
        <DetailCard icon={CreditCard} label="Qolgan qarz" value={formatCurrency(item.debtAmount || 0)} danger />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <TextBlock icon={FileText} label="Buyurtma matni" value={item.orderText} />
        <TextBlock icon={UserRound} label="Izoh" value={item.note || 'Izoh kiritilmagan'} />
      </div>
    </>
  );
}

function SaleArchiveDetails({ item, telegramEnabled = false }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <DetailCard icon={UserRound} label="Mijoz" value={item.customerName || '-'} copyable />
        <DetailCard icon={Phone} label="Aloqa telefoni" value={item.phone || '-'} copyable />
        {telegramEnabled && <DetailCard icon={Send} label="Telegram telefoni" value={item.telegramPhone || item.phone || '-'} copyable />}
        <DetailCard icon={CalendarClock} label="Yaratilgan sana" value={formatDate(item.createdAt)} />
        <DetailCard icon={CalendarClock} label="Yangilangan sana" value={formatDate(item.updatedAt)} />
        <DetailCard icon={FileText} label="To'lov turi" value={paymentTypeLabels[item.paymentType] || item.paymentType} />
        <DetailCard icon={FileText} label="Yozuv ID" value={item._id || item.id} copyable />
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        <DetailCard icon={CreditCard} label="Jami summa" value={formatCurrency(item.amount)} />
        <DetailCard icon={CreditCard} label="Qilingan to'lov" value={formatCurrency(item.paidAmount || 0)} />
        <DetailCard icon={CreditCard} label="Qolgan qarz" value={formatCurrency(item.debtAmount || 0)} danger />
        <DetailCard icon={CreditCard} label="Tannarx" value={formatCurrency(item.costPrice || 0)} />
        <DetailCard icon={CreditCard} label="Foyda" value={formatCurrency(item.profit || 0)} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <TextBlock icon={Gift} label="Sovga/tovar nomi" value={item.productName || 'Sovga/tovar'} />
        <TextBlock icon={UserRound} label="Izoh" value={item.note || 'Izoh kiritilmagan'} />
      </div>
    </>
  );
}

function DetailCard({ icon: Icon, label, value, danger, copyable }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/30 p-3">
      <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
        <Icon className={`h-4 w-4 ${danger ? 'text-amber-300' : 'text-rose-300'}`} />
        {label}
      </p>
      <p className={`break-words text-sm font-semibold ${danger ? 'text-amber-200' : 'text-slate-100'}`}>
        {copyable ? <CopyableText value={value} label={`${label}ni nusxalash`} /> : value || '-'}
      </p>
    </div>
  );
}

function TextBlock({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/30 p-4">
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
        <Icon className="h-4 w-4 text-sky-300" />
        {label}
      </p>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{value || '-'}</p>
    </div>
  );
}

function PaymentHistory({ payments }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/30 p-4">
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
        <CreditCard className="h-4 w-4 text-emerald-300" />
        Qarz to'lovlari tarixi
      </p>
      {payments.length === 0 ? (
        <p className="text-sm text-slate-400">Qo'shimcha qarz to'lovi kiritilmagan.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Sana</th>
                <th className="px-3 py-2">To'lov turi</th>
                <th className="px-3 py-2">Summa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {payments.map((payment, index) => (
                <tr key={`${payment.paidAt || index}-${payment.amount || 0}`}>
                  <td className="px-3 py-2 font-bold text-slate-500">{index + 1}</td>
                  <td className="px-3 py-2 text-slate-300">{formatDate(payment.paidAt)}</td>
                  <td className="px-3 py-2 text-slate-300">{paymentTypeLabels[payment.paymentType] || payment.paymentType || '-'}</td>
                  <td className="px-3 py-2 font-bold text-slate-100">{formatCurrency(payment.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function rowKey(row) {
  return `${row.type}:${row.item._id}`;
}

function Summary({ label, value, danger }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/25 p-3">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className={`mt-1 font-bold ${danger ? 'text-amber-200' : 'text-slate-100'}`}>{value}</p>
    </div>
  );
}
