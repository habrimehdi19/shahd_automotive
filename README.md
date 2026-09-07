# MR GARAGE — دليل التشغيل

هاد النسخة ولات Multi-Company / SaaS: عندك **Super Admin** واحد، ومن خلاله كتخلق وتدير جميع الكاراجات. كل كاراج عندو اسم الشركة، Logo، Username وPassword خاصين به، والبيانات ديالو معزولة على باقي الشركات.

## الروابط
- `/login` : دخول صاحب الكاراج.
- `/admin/login` : دخول Super Admin ديالك.
- `/admin` : لوحة التحكم الرئيسية ديالك.
- `/employee` : مساحة الموظفين.

## Environment Variables
- `DASHBOARD_PASSWORD` : كلمة سر Super Admin.
- `AUTH_SESSION_SECRET` : سر قوي لتوقيع جلسات الدخول.
- `COMPANY_NAME` : اسم الكاراج الافتراضي الأول.
- `COMPANY_USERNAME` : Username ديال الكاراج الافتراضي الأول.
- `COMPANY_DEFAULT_PASSWORD` : Password ديال الكاراج الافتراضي الأول.
- `BOT_COMPANY_ID` : ID ديال الشركة المرتبطة ببوت Telegram إذا استعملتي البوت.
- `TELEGRAM_BOT_TOKEN` : Token ديال Telegram (مطلوب حالياً لتشغيل البوت).

**مهم:** استعمل كلمات سر قوية فـ Railway، خصوصاً `DASHBOARD_PASSWORD` و`AUTH_SESSION_SECRET`.

## إنشاء كاراج جديد
1. دخل إلى `/admin/login`.
2. دخل كلمة سر Super Admin.
3. اضغط **Nouveau garage**.
4. حدد اسم الشركة، Username، Password، الهاتف، الإيميل والعنوان.
5. من بعد اختار **Changer logo** ورفع Logo ديال الشركة.

منين صاحب الكاراج يدخل من `/login` غادي يشوف غير الاسم والـLogo والبيانات ديالو.

## ملاحظة على التخزين
هاد المرحلة كتستعمل JSON files مع `companyId` لعزل الشركات، وهي مناسبة للـMVP والتجارب. قبل ما توصل لعدد كبير من الزبناء، الخطوة التالية الموصى بها هي نقل البيانات إلى PostgreSQL (خصوصاً إذا كان Railway غادي يشغل أكثر من instance).

## Telegram Multi-Garage

Le SaaS utilise un seul bot Telegram pour plusieurs garages. Chaque garage reçoit un `telegramKey` unique et possède:
- un Customer Link unique (`/start garage_<key>`) pour les clients;
- un Owner Connect Link (`/start owner_<key>`) pour connecter le compte Telegram du responsable;
- un `telegramChatId` indépendant pour les notifications.

Les rendez-vous, disponibilités, listes d'attente et notifications sont isolés par `companyId`. Un client ne peut pas suivre un code appartenant à un autre garage via le bot.

Dans le Super Admin, les boutons **Telegram** et **Lien client** permettent de récupérer les deux liens.

Variables Railway:
- `TELEGRAM_BOT_TOKEN` obligatoire
- `DASHBOARD_PASSWORD` obligatoire en production
- `TELEGRAM_BOT_USERNAME` optionnel (le bot peut récupérer son username automatiquement)

## 🤖 Mise à jour : un bot Telegram par garage (au lieu d'un bot partagé)

Chaque garage a maintenant **son propre bot Telegram** (son propre token, créé via @BotFather), au lieu d'un seul bot partagé avec des liens de type `?start=garage_xxx`.

- `TELEGRAM_BOT_TOKEN` n'est **plus une variable d'environnement obligatoire**. Le serveur démarre normalement même sans bot configuré.
- Le token de chaque garage se configure depuis `/admin` → bouton **"Bot Telegram"** sur la carte du garage.
- Une fois le token enregistré, le bot de ce garage démarre automatiquement (sans redémarrer le serveur).
- Le propriétaire du garage doit envoyer `/owner` à son propre bot une fois, puis cliquer sur "✅ Activer les notifications ici", pour recevoir les notifications de nouveaux rendez-vous sur son propre chat Telegram.
- Les clients discutent directement avec le bot du garage (son `@username` Telegram) — plus besoin de lien de démarrage spécial.

## 💾 Persistance des données (important sur Railway)

Toutes les données (companies.json, employees.json, appointments.json, photos, logos uploadés...) sont maintenant stockées dans un dossier unique déterminé par la variable d'environnement `RAILWAY_VOLUME_MOUNT_PATH` (fournie automatiquement par Railway quand un **Volume** est attaché au service).

⚠️ **Ne montez JAMAIS le Volume sur `/app`** (ça écrase le code de l'application et fait planter le serveur — `CRASHED`). Montez-le sur un sous-dossier dédié, par exemple :

```
/app/data
```

Sans Volume attaché (ou en local), les données sont stockées dans le dossier `./data` à côté de `server.js` — mais sur Railway, ce dossier est réinitialisé à chaque nouveau déploiement si aucun Volume n'est attaché.

Le secret de signature des sessions (`AUTH_SESSION_SECRET`) est aussi sauvegardé automatiquement dans ce dossier persistant, pour que les connexions ne soient pas invalidées à chaque redéploiement.
