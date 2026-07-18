# Dinora Gullari Windows App

Dinora Gullari - gul do'koni uchun lokal Windows CRM dasturi. Dastur kompyuterning o'zida ishlaydi: Electron oynasi frontendni ochadi, NestJS backend lokal server sifatida `127.0.0.1:5000`da ishga tushadi, ma'lumotlar SQLite bazasida saqlanadi.

## Imkoniyatlar

- Buyurtmalar, sotuvlar, qarzlar, tarix/arxiv, dashboard va hisobotlar.
- Users, auth, sozlamalar va lokal backup/export.
- Telegram bot orqali mijozlarga xabar yuborish.
- Internet bo'lsa Telegram xabarlar va app yangilanishlari ishlaydi; internet bo'lmasa asosiy CRM lokal ishlashda davom etadi.
- Electron auto-update: GitHub Releases orqali yangi versiyalarni yuklab oladi.

## Stack

- Desktop: Electron, electron-builder, electron-updater.
- Frontend: React, Vite, Redux Toolkit RTK Query, React Router, Tailwind CSS.
- Backend: NestJS, TypeScript, SQLite/sql.js, JWT auth, Telegram Bot API.

## O'rnatish

```powershell
npm run install:all
```

## Ishga tushirish

```powershell
npm run desktop
```

Bu buyruq backend va frontendni build qiladi, keyin Electron oynasini ochadi.

## Windows installer build

```powershell
npm run dist:win
```

`runtime/node.exe` GitHubga commit qilinmaydi. `dist:win` ishga tushganda u kerak bo'lsa Node rasmiy saytidan avtomatik yuklanadi.

Installer fayllari `release/` papkasiga chiqadi:

- `DinoraGullari-Setup-x64.exe`
- `DinoraGullari-Setup-x64.exe.blockmap`
- `latest.yml`

`release/` GitHubga commit qilinmaydi.

## Auto-update chiqarish

Yangi versiya chiqarishdan oldin `package.json`dagi `version`ni oshiring:

```powershell
npm version patch --no-git-tag-version
```

GitHub tokenni faqat lokal terminalda bering:

```powershell
$env:GH_TOKEN="github_token"
npm run publish:win
```

`publish:win` GitHub Releasesga installer, blockmap va `latest.yml`ni yuklaydi. Foydalanuvchilar birinchi marta installerni qo'lda o'rnatadi; keyingi versiyalar internet bo'lsa dastur ichida avtomatik yuklanadi.

## Lokal ma'lumotlar

SQLite bazasi foydalanuvchi kompyuterida saqlanadi:

```text
%APPDATA%\Dinora Gullari\dinora-gullari.sqlite
```

Installer yangilanganda bu baza o'chirilmaydi. `nsis.deleteAppDataOnUninstall` ham `false` qilib qo'yilgan.

## Loglar

```text
%APPDATA%\dinora-gullari-windows\logs\desktop-main.log
%APPDATA%\dinora-gullari-windows\logs\backend.out.log
%APPDATA%\dinora-gullari-windows\logs\backend.err.log
```

## Muhim xavfsizlik

- Real `.env` fayllarni commit qilmang.
- Telegram bot tokenni public repoga yozmang.
- Har bir mijoz uchun alohida bot token ishlatish tavsiya qilinadi.
- Hozirgi build unsigned. Keng tarqatishdan oldin Windows code signing sertifikat olish kerak.
