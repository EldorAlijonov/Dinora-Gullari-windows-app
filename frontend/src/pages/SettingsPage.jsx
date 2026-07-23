import { Camera, ChevronDown, Eye, EyeOff, Image, KeyRound, Link2, Lock, Plus, Save, Send, Store, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PasswordInput } from '../components/ui/PasswordInput';
import { Textarea } from '../components/ui/Textarea';
import { updateUser } from '../features/auth/authSlice';
import { useChangePasswordMutation, useSettingsQuery, useTestGoogleSheetsMutation, useUpdateMeMutation, useUpdateSettingsMutation } from '../services/api';
import { getErrorMessage } from '../utils/errorMessage';

const defaultSettings = {
  storeName: 'Dinora Gullari',
  storePhone: '',
  storeAddress: '',
  workHours: '',
  logoUrl: '',
  telegramBotToken: '',
  telegramBotConfigured: false,
  telegramOrderAcceptedEnabled: true,
  telegramOrderStatusEnabled: true,
  telegramDebtReminderEnabled: true,
  telegramDebtPaymentEnabled: true,
  telegramSaleCreatedEnabled: true,
  telegramAdminIds: [],
  requirePhoneForDebtSales: true,
  debtReminderAfterDays: 3,
  preventSameDayDebtReminder: true,
  debtReminderText: "Qarzdorlik bo'yicha eslatma.",
  googleSheetsEnabled: false,
  googleSheetsSpreadsheetId: '',
  googleSheetsServiceAccountEmail: '',
  googleSheetsPrivateKey: '',
  googleSheetsOrdersSheet: 'Orders',
  googleSheetsSalesSheet: 'Sales',
};

function Toggle({ label, description, checked, onChange, disabled = false }) {
  return (
    <label className={`flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-slate-950/25 p-3 ${disabled ? 'opacity-60' : ''}`}>
      <span>
        <span className="block text-sm font-bold text-slate-100">{label}</span>
        {description && <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>}
      </span>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 accent-rose-400 disabled:cursor-not-allowed"
      />
    </label>
  );
}

function AccordionSection({ id, icon: Icon, title, description, open, onToggle, children }) {
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-panel/70">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-white/5"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/8 text-rose-200">
            <Icon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-bold text-slate-100">{title}</span>
            {description && <span className="mt-1 block text-sm text-slate-500">{description}</span>}
          </span>
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-white/10 px-5 py-5">{children}</div>}
    </section>
  );
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function readImageAsDataUrl(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(objectUrl);
    const maxSide = 720;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/webp', 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function normalizeGooglePrivateKey(value) {
  const trimmed = value.trim();
  let keyValue = value;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') keyValue = parsed;
    else if (parsed?.private_key) keyValue = parsed.private_key;
  } catch {
    const jsonFieldMatch = trimmed.match(/"private_key"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (jsonFieldMatch?.[1]) {
      try {
        keyValue = JSON.parse(`"${jsonFieldMatch[1]}"`);
      } catch {
        keyValue = jsonFieldMatch[1];
      }
    } else {
      const beginIndex = value.indexOf('-----BEGIN PRIVATE KEY-----');
      const endMarker = '-----END PRIVATE KEY-----';
      const endIndex = value.indexOf(endMarker);
      if (beginIndex >= 0 && endIndex >= beginIndex) {
        keyValue = value.slice(beginIndex, endIndex + endMarker.length);
      }
    }
  }

  return keyValue
    .replace(/^\s*"|"\s*,?\s*$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function cleanSettingsForSave(settings, { clearTelegramBotToken = false } = {}) {
  const {
    key: _key,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    telegramBotConfigured: _telegramBotConfigured,
    telegramBotToken,
    ...payload
  } = settings;
  const token = String(telegramBotToken || '').trim();

  if (token) payload.telegramBotToken = token;
  if (clearTelegramBotToken) payload.telegramBotToken = '';
  payload.debtReminderAfterDays = Number(payload.debtReminderAfterDays || defaultSettings.debtReminderAfterDays);
  payload.telegramAdminIds = Array.isArray(payload.telegramAdminIds) ? payload.telegramAdminIds : [];

  return payload;
}

export default function SettingsPage() {
  const dispatch = useDispatch();
  const user = useSelector((state) => state.auth.user);
  const { data: settingsData, isLoading } = useSettingsQuery();
  const [updateSettings, settingsState] = useUpdateSettingsMutation();
  const [testGoogleSheets, googleSheetsTestState] = useTestGoogleSheetsMutation();
  const [updateMe, profileState] = useUpdateMeMutation();
  const [changePassword, passwordState] = useChangePasswordMutation();
  const [openSections, setOpenSections] = useState({ store: true, account: false, telegram: false, google: false });
  const [settings, setSettings] = useState(defaultSettings);
  const [telegramAdminInput, setTelegramAdminInput] = useState('');
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [profile, setProfile] = useState({ fullName: '', username: '', phone: '', avatarUrl: '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const telegramConfigured = Boolean(settings.telegramBotConfigured);

  useEffect(() => {
    if (!settingsData) return;
    setSettings({ ...defaultSettings, ...settingsData, telegramBotToken: '' });
  }, [settingsData]);

  useEffect(() => {
    setProfile({
      fullName: user?.fullName || '',
      username: user?.username || '',
      phone: user?.phone || '',
      avatarUrl: user?.avatarUrl || '',
    });
  }, [user]);

  const toggleSection = (id) => {
    setOpenSections((current) => ({ ...current, [id]: !current[id] }));
  };

  const setSetting = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  const chooseImage = async (event, callback) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readImageAsDataUrl(file);
      callback(dataUrl);
    } catch {
      toast.error('Rasmni yuklashda xatolik yuz berdi');
    } finally {
      event.target.value = '';
    }
  };

  const saveSettings = async (options) => {
    try {
      const saved = await updateSettings(cleanSettingsForSave(settings, options)).unwrap();
      setSettings({ ...defaultSettings, ...saved, telegramBotToken: '' });
      toast.success('Sozlamalar saqlandi');
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error, 'Sozlamalarni saqlashda xatolik'));
      return false;
    }
  };

  const saveProfile = async () => {
    try {
      const saved = await updateMe(profile).unwrap();
      dispatch(updateUser(saved));
      toast.success('Profil yangilandi');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Profilni yangilashda xatolik'));
    }
  };

  const savePassword = async () => {
    if (passwords.newPassword.length < 6) {
      toast.error('Yangi parol kamida 6 ta belgidan iborat bo\'lsin');
      return;
    }
    if (passwords.newPassword !== passwords.confirmPassword) {
      toast.error('Yangi parollar mos kelmadi');
      return;
    }
    try {
      await changePassword({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword }).unwrap();
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success('Parol yangilandi');
    } catch {
      toast.error('Joriy parol noto\'g\'ri yoki xatolik yuz berdi');
    }
  };

  const addTelegramAdmin = () => {
    const value = telegramAdminInput.trim();
    if (!/^-?\d+$/.test(value)) {
      toast.error('Telegram chat ID faqat raqamlardan iborat bo\'lsin');
      return;
    }
    setSettings((current) => ({
      ...current,
      telegramAdminIds: [...new Set([...(current.telegramAdminIds || []), value])],
    }));
    setTelegramAdminInput('');
  };

  const removeTelegramAdmin = (chatId) => {
    setSettings((current) => ({
      ...current,
      telegramAdminIds: (current.telegramAdminIds || []).filter((value) => value !== chatId),
    }));
  };

  const handleTestGoogleSheets = async () => {
    try {
      const saved = await saveSettings();
      if (!saved) return;
      const result = await testGoogleSheets().unwrap();
      toast.success(result.message || 'Google Sheets ulanishi ishlayapti');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Google Sheets ulanishida xatolik'));
    }
  };

  if (isLoading) {
    return <div className="rounded-lg border border-white/10 bg-panel/70 p-8 text-center text-slate-400">Yuklanmoqda...</div>;
  }

  return (
    <div className="space-y-4">
      <AccordionSection
        id="store"
        icon={Store}
        title="Do'kon ma'lumotlari"
        description="Nom, telefon, manzil, ish vaqti va logotip."
        open={openSections.store}
        onToggle={toggleSection}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Do'kon nomi" value={settings.storeName} onChange={(event) => setSetting('storeName', event.target.value)} />
          <Input label="Do'kon telefoni" value={settings.storePhone} onChange={(event) => setSetting('storePhone', event.target.value)} />
          <Input label="Ish vaqti" value={settings.workHours} onChange={(event) => setSetting('workHours', event.target.value)} />
          <Input label="Manzil" value={settings.storeAddress} onChange={(event) => setSetting('storeAddress', event.target.value)} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg border border-white/10 bg-slate-950/25 p-4">
          <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-lg border border-white/10 bg-white/8">
            {settings.logoUrl ? <img src={settings.logoUrl} alt="Logo" className="h-full w-full object-cover" /> : <Image className="h-7 w-7 text-slate-500" />}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/8 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/12">
            <Image className="h-4 w-4" />
            Logoni tanlash
            <input type="file" accept="image/*" className="hidden" onChange={(event) => chooseImage(event, (value) => setSetting('logoUrl', value))} />
          </label>
        </div>

        <Button type="button" loading={settingsState.isLoading} className="mt-4" onClick={() => saveSettings()}>
          <Save className="h-4 w-4" /> Saqlash
        </Button>
      </AccordionSection>

      <AccordionSection
        id="account"
        icon={UserRound}
        title="Login va parol"
        description="Admin profili, login ma'lumotlari va parolni almashtirish."
        open={openSections.account}
        onToggle={toggleSection}
      >
        <div className="grid gap-5 xl:grid-cols-2">
          <div>
            <div className="mb-4 flex items-center gap-4">
              <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-full border border-white/10 bg-white/8">
                {profile.avatarUrl ? <img src={profile.avatarUrl} alt="Profil rasmi" className="h-full w-full object-cover" /> : <UserRound className="h-8 w-8 text-slate-500" />}
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/8 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/12">
                <Camera className="h-4 w-4" />
                Profil rasmi
                <input type="file" accept="image/*" className="hidden" onChange={(event) => chooseImage(event, (value) => setProfile((current) => ({ ...current, avatarUrl: value })))} />
              </label>
            </div>
            <div className="space-y-4">
              <Input label="Ism familiya" value={profile.fullName} onChange={(event) => setProfile((current) => ({ ...current, fullName: event.target.value }))} />
              <Input label="Login" value={profile.username} onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))} />
              <Input label="Telefon" value={profile.phone} onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))} />
            </div>
            <Button type="button" loading={profileState.isLoading} className="mt-4" onClick={saveProfile}>
              <Save className="h-4 w-4" /> Profilni saqlash
            </Button>
          </div>

          <div className="rounded-lg border border-white/10 bg-slate-950/25 p-4">
            <div className="mb-4 flex items-center gap-3">
              <Lock className="h-5 w-5 text-emerald-300" />
              <h3 className="font-bold text-slate-100">Parol almashtirish</h3>
            </div>
            <div className="space-y-4">
              <PasswordInput label="Joriy parol" value={passwords.currentPassword} onChange={(event) => setPasswords((current) => ({ ...current, currentPassword: event.target.value }))} />
              <PasswordInput label="Yangi parol" value={passwords.newPassword} onChange={(event) => setPasswords((current) => ({ ...current, newPassword: event.target.value }))} />
              <PasswordInput label="Yangi parolni takrorlang" value={passwords.confirmPassword} onChange={(event) => setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))} />
            </div>
            <Button type="button" loading={passwordState.isLoading} className="mt-4" onClick={savePassword}>
              <KeyRound className="h-4 w-4" /> Parolni yangilash
            </Button>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection
        id="telegram"
        icon={Send}
        title="Telegram bot va xabarlar"
        description="Bot token, admin chat IDlari va mijozlarga yuboriladigan xabarlar."
        open={openSections.telegram}
        onToggle={toggleSection}
      >
        <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
          <div className="space-y-4">
            <div className="rounded-lg border border-white/10 bg-slate-950/25 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-bold text-slate-100">Telegram bot</h3>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${telegramConfigured ? 'border-emerald-300/20 bg-emerald-400/10 text-emerald-200' : 'border-amber-300/20 bg-amber-400/10 text-amber-200'}`}>
                  {telegramConfigured ? 'Ulangan' : 'Ulanmagan'}
                </span>
              </div>
              <PasswordInput
                label="Bot token"
                placeholder={telegramConfigured ? 'Yangi token kiritsangiz eskisi almashadi' : 'BotFather tokenini kiriting'}
                value={settings.telegramBotToken}
                onChange={(event) => setSetting('telegramBotToken', event.target.value)}
                visibleLabel="Tokenni ko'rish"
                hiddenLabel="Tokenni yashirish"
              />
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" loading={settingsState.isLoading} onClick={() => saveSettings()}>
                  <Save className="h-4 w-4" /> Botni saqlash
                </Button>
                {telegramConfigured && (
                  <Button type="button" variant="danger" loading={settingsState.isLoading} onClick={() => saveSettings({ clearTelegramBotToken: true })}>
                    Botni olib tashlash
                  </Button>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-slate-950/25 p-4">
              <h3 className="font-bold text-slate-100">Telegram adminlar</h3>
              <div className="mt-3 flex gap-2">
                <Input
                  aria-label="Telegram admin chat ID"
                  placeholder="123456789"
                  value={telegramAdminInput}
                  onChange={(event) => setTelegramAdminInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTelegramAdmin();
                    }
                  }}
                />
                <Button type="button" variant="secondary" onClick={addTelegramAdmin} className="px-3">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-3 space-y-2">
                {(settings.telegramAdminIds || []).length === 0 ? (
                  <p className="text-sm text-slate-500">Admin chat ID qo'shilmagan.</p>
                ) : (
                  settings.telegramAdminIds.map((chatId) => (
                    <div key={chatId} className="flex items-center justify-between gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                      <span>{chatId}</span>
                      <button
                        type="button"
                        className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-300"
                        onClick={() => removeTelegramAdmin(chatId)}
                        title="Adminni olib tashlash"
                        aria-label="Adminni olib tashlash"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-3">
              <Toggle disabled={!telegramConfigured} label="Buyurtma qabul qilinganda xabar" checked={settings.telegramOrderAcceptedEnabled} onChange={(value) => setSetting('telegramOrderAcceptedEnabled', value)} />
              <Toggle disabled={!telegramConfigured} label="Buyurtma statusi va olib ketish xabarlari" checked={settings.telegramOrderStatusEnabled} onChange={(value) => setSetting('telegramOrderStatusEnabled', value)} />
              <Toggle disabled={!telegramConfigured} label="Qarzdorlik eslatmalari" checked={settings.telegramDebtReminderEnabled} onChange={(value) => setSetting('telegramDebtReminderEnabled', value)} />
              <Toggle disabled={!telegramConfigured} label="Qarz to'lovi xabarlari" checked={settings.telegramDebtPaymentEnabled} onChange={(value) => setSetting('telegramDebtPaymentEnabled', value)} />
              <Toggle disabled={!telegramConfigured} label="Sovga/tovar xaridi xabari" checked={settings.telegramSaleCreatedEnabled} onChange={(value) => setSetting('telegramSaleCreatedEnabled', value)} />
            </div>

            <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
              <Input label="Necha kundan keyin" type="number" min="0" value={settings.debtReminderAfterDays} onChange={(event) => setSetting('debtReminderAfterDays', event.target.value)} />
              <Textarea label="Qarz eslatmasi matni" value={settings.debtReminderText} onChange={(event) => setSetting('debtReminderText', event.target.value)} />
            </div>
            <div className="grid gap-3">
              <Toggle label="Nasiya savdoda telefon majburiy" description="Telefon bo'lmasa qarz yozuvini keyin topish qiyinlashadi." checked={settings.requirePhoneForDebtSales} onChange={(value) => setSetting('requirePhoneForDebtSales', value)} />
              <Toggle disabled={!telegramConfigured} label="Bir kunda qayta eslatmaslik" checked={settings.preventSameDayDebtReminder} onChange={(value) => setSetting('preventSameDayDebtReminder', value)} />
            </div>
            <Button type="button" loading={settingsState.isLoading} onClick={() => saveSettings()}>
              <Save className="h-4 w-4" /> Saqlash
            </Button>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection
        id="google"
        icon={Link2}
        title="Google Sheets"
        description="Ixtiyoriy tashqi jadvalga yozish sozlamalari."
        open={openSections.google}
        onToggle={toggleSection}
      >
        <div className="space-y-4">
          <Toggle
            label="Google Sheetsga avtomatik yozish"
            description="Buyurtma yoki sovga/tovar sotuv yaratilganda Google Sheetsga ham alohida qator qo'shiladi."
            checked={settings.googleSheetsEnabled}
            onChange={(value) => setSetting('googleSheetsEnabled', value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Spreadsheet ID" value={settings.googleSheetsSpreadsheetId} onChange={(event) => setSetting('googleSheetsSpreadsheetId', event.target.value)} />
            <Input label="Service account email" value={settings.googleSheetsServiceAccountEmail} onChange={(event) => setSetting('googleSheetsServiceAccountEmail', event.target.value)} />
            <Input label="Buyurtmalar sheet nomi" value={settings.googleSheetsOrdersSheet} onChange={(event) => setSetting('googleSheetsOrdersSheet', event.target.value)} />
            <Input label="Sotuvlar sheet nomi" value={settings.googleSheetsSalesSheet} onChange={(event) => setSetting('googleSheetsSalesSheet', event.target.value)} />
          </div>
          <Textarea
            label="Service account private key"
            type={showGoogleKey ? 'text' : 'password'}
            placeholder="Private key"
            value={settings.googleSheetsPrivateKey}
            onChange={(event) => setSetting('googleSheetsPrivateKey', normalizeGooglePrivateKey(event.target.value))}
          />
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-400 transition hover:text-slate-200"
            onClick={() => setShowGoogleKey((current) => !current)}
          >
            {showGoogleKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showGoogleKey ? 'Private keyni yashirish' : "Private keyni ko'rish"}
          </button>
          <div className="flex flex-wrap gap-2">
            <Button type="button" loading={settingsState.isLoading} onClick={() => saveSettings()}>
              <Save className="h-4 w-4" /> Saqlash
            </Button>
            <Button type="button" variant="secondary" loading={googleSheetsTestState.isLoading} onClick={handleTestGoogleSheets}>
              Ulanishni tekshirish
            </Button>
          </div>
        </div>
      </AccordionSection>
    </div>
  );
}
