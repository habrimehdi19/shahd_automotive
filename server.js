// ===== {{COMPANY_NAME}} — Serveur (Telegram Bot + API + Dashboard) =====
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const multer = require("multer");
const crypto = require("crypto");

// ---------- الإعدادات ----------
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "change-me-admin"; // Super Admin password

// مهم: على Railway خاصك تربط Volume وتحط المسار ديالها هنا (Mount Path)، باش الداطا (companies.json,
// employees.json, appointments.json...) تبقى محفوظة بين كل deploy وdeploy. Railway كيعطي المسار
// أوتوماتيكيا فـ RAILWAY_VOLUME_MOUNT_PATH منين تكون الـ Volume مربوطة. إلا ماكانتش مربوطة (تجربة محلية)،
// كنخدمو بمجلد "data" جوج الكود بوحدو (بلا Volume الداطا غادي تتمسح عند كل deploy جديد على Railway).
const DATA_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });

const COMPANIES_FILE = path.join(DATA_ROOT, "companies.json");
const DATA_FILE = path.join(DATA_ROOT, "appointments.json");
const EMPLOYEES_FILE = path.join(DATA_ROOT, "employees.json");
const WAITLIST_FILE = path.join(DATA_ROOT, "waitlist.json");
const INVENTORY_FILE = path.join(DATA_ROOT, "inventory.json");
const UPLOADS_DIR = path.join(DATA_ROOT, "uploads");
const BOT_LANG_FILE = path.join(DATA_ROOT, "botlang.json");
const SESSION_SECRET_FILE = path.join(DATA_ROOT, "session-secret.json");

// ---------- سر توقيع الجلسات (session) — لازم يبقى ثابت بين كل deploy، وإلا كل الجلسات كتبطل ----------
const AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || (function () {
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) return JSON.parse(fs.readFileSync(SESSION_SECRET_FILE, "utf8")).secret;
  } catch {}
  const secret = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(SESSION_SECRET_FILE, JSON.stringify({ secret }), "utf8"); } catch {}
  return secret;
})();

// ---------- Telegram Multi-Garage ----------
// كل ورشة (Garage) عندها بوت Telegram خاص بيها بوحدها (توكن ديالها من @BotFather).
// Twilio (اختياري) : باش تصيفط SMS/WhatsApp تلقائي للزبون. إلا ماكانوش هاد المتغيرات، غادي نخدمو بلا هاد الخاصية (بلا ما يطيح السيرفر).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ""; // مثال: whatsapp:+14155238886
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || ""; // مثال: +1415XXXXXXX


// ---------- Multi-company / SaaS ----------
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); }
function slugify(value) {
  return String(value || "company").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "company";
}

const CURRENCY_CODES = new Set([
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP","STN","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XOF","XPF","YER","ZAR","ZMW","ZWL"
]);
function normalizeCurrency(value) {
  const c = String(value || "MAD").trim().toUpperCase();
  return CURRENCY_CODES.has(c) ? c : "MAD";
}
function normalizeCountry(value) {
  const c = String(value || "MA").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : "MA";
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}
function verifyPassword(password, record) {
  if (!record?.passwordHash || !record?.passwordSalt) return false;
  try {
    const hash = crypto.scryptSync(String(password), record.passwordSalt, 64).toString("hex");
    return hash.length === record.passwordHash.length && crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(record.passwordHash, "hex"));
  } catch { return false; }
}
let companies = loadJson(COMPANIES_FILE, []);
if (!companies.length) {
  const { salt, hash } = hashPassword(process.env.COMPANY_DEFAULT_PASSWORD || "change-me-company");
  companies = [{ id: "company_default", name: process.env.COMPANY_NAME || "Votre garage", slug: slugify(process.env.COMPANY_NAME || "Votre garage"), logo: "/mr-garage-logo.png", phone: "", email: "", address: "", country: normalizeCountry(process.env.COMPANY_COUNTRY || "MA"), currency: normalizeCurrency(process.env.COMPANY_CURRENCY || "MAD"), username: process.env.COMPANY_USERNAME || "garage", passwordSalt: salt, passwordHash: hash, active: true, telegramBotToken: "", telegramChatId: "", createdAt: new Date().toISOString() }];
  saveJson(COMPANIES_FILE, companies);
}
function getCompany(id) { return companies.find(c => String(c.id) === String(id)) || null; }
function companyOf(id) { return getCompany(id) || companies[0]; }

function signAuth(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyAuth(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", AUTH_SESSION_SECRET).update(body).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function setAuthCookie(req, res, payload) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `auth=${encodeURIComponent(signAuth(payload))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${isHttps ? "; Secure" : ""}`);
}
function getAuth(req) { return verifyAuth(parseCookies(req).auth || ""); }
function getCompanyFromRequest(req) {
  const auth = getAuth(req);
  if (!auth || auth.role !== "company" || !auth.companyId) return null;
  const company = getCompany(auth.companyId);
  return company?.active !== false ? company : null;
}
function requireCompany(req, res, next) {
  const company = getCompanyFromRequest(req);
  if (!company) return res.status(401).json({ error: "COMPANY_AUTH_REQUIRED" });
  req.company = company;
  next();
}
function requireAdmin(req, res, next) {
  const auth = getAuth(req);
  if (!auth || auth.role !== "superadmin") return res.status(401).json({ error: "ADMIN_AUTH_REQUIRED" });
  req.admin = auth;
  next();
}
function addCompanyId(list, defaultId) {
  let changed = false;
  for (const item of list) { if (!item.companyId) { item.companyId = defaultId; changed = true; } }
  return changed;
}
function scoped(list, companyId) { return list.filter(x => String(x.companyId || "company_default") === String(companyId)); }
function ensureCompanyDataMigration() {
  const id = companies[0].id;
  const files = [DATA_FILE, EMPLOYEES_FILE, INVOICES_FILE, WAITLIST_FILE, INVENTORY_FILE, BOT_LANG_FILE];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const val = loadJson(file, Array.isArray(file === BOT_LANG_FILE ? {} : []) ? [] : {});
    if (Array.isArray(val)) { if (addCompanyId(val, id)) saveJson(file, val); }
  }
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- تخزين المواعيد (ملف JSON بسيط) ----------
function loadAppointments() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveAppointments(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
}
let appointments = loadAppointments();

// ---------- تخزين العمال ----------
function loadEmployees() {
  if (!fs.existsSync(EMPLOYEES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(EMPLOYEES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveEmployees(list) {
  fs.writeFileSync(EMPLOYEES_FILE, JSON.stringify(list, null, 2), "utf8");
}
let employees = loadEmployees();

// ---------- Sessions العمال ----------
// Session stateless وموقعة: ما كتضيعش إلا السيرفر تعاود تشغيلو، وما كتحتاجش Map فالذاكرة.
const EMPLOYEE_SESSION_SECRET = process.env.EMPLOYEE_SESSION_SECRET || DASHBOARD_PASSWORD;
function signEmployeeSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", EMPLOYEE_SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyEmployeeSession(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", EMPLOYEE_SESSION_SECRET).update(body).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.employeeId || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function hashEmployeePassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyEmployeePassword(password, emp) {
  if (!emp || !emp.passwordHash || !emp.passwordSalt) return false;
  try {
    const hash = crypto.scryptSync(String(password), emp.passwordSalt, 64).toString("hex");
    return hash.length === emp.passwordHash.length && crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(emp.passwordHash, "hex"));
  } catch { return false; }
}
function createEmployeeSession(employeeId) {
  const emp = employees.find(e => Number(e.id) === Number(employeeId));
  return signEmployeeSession({ employeeId: Number(employeeId), companyId: emp?.companyId || "company_default", exp: Date.now() + 86400000 });
}
function getEmployeeFromRequest(req) {
  const cookies = parseCookies(req);
  const payload = verifyEmployeeSession(cookies.employee_session || "");
  if (!payload) return null;
  return employees.find(e => Number(e.id) === Number(payload.employeeId) && String(e.companyId || "company_default") === String(payload.companyId || "company_default")) || null;
}
function setEmployeeCookie(req, res, token) {
  // Railway كيدوز HTTPS عبر proxy؛ كنستعمل Secure غير ملي الطلب فعلاً HTTPS.
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secure = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `employee_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${secure}`);
}
function clearEmployeeCookie(req, res) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secure = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `employee_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

// ---------- تخزين الفواتير ----------
const INVOICES_FILE = path.join(__dirname, "invoices.json");
function loadInvoices() {
  if (!fs.existsSync(INVOICES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INVOICES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveInvoices(list) {
  fs.writeFileSync(INVOICES_FILE, JSON.stringify(list, null, 2), "utf8");
}
let invoices = loadInvoices();

// ---------- تخزين لائحة الانتظار (waitlist) ----------
function loadWaitlist() {
  if (!fs.existsSync(WAITLIST_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(WAITLIST_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveWaitlist(list) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2), "utf8");
}
let waitlist = loadWaitlist();

// ---------- تخزين المخزون (قطع الغيار) ----------
function loadInventory() {
  if (!fs.existsSync(INVENTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveInventory(list) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(list, null, 2), "utf8");
}
let inventory = loadInventory();

// ---------- تخزين لغة كل زبون فالبوت (fr / en / es) — مفتاح: companyId:chatId ----------
function loadBotLang() {
  if (!fs.existsSync(BOT_LANG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BOT_LANG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveBotLang(obj) {
  fs.writeFileSync(BOT_LANG_FILE, JSON.stringify(obj, null, 2), "utf8");
}
let botLang = loadBotLang();
function getBotLang(companyId, chatId) {
  return botLang[`${companyId}:${chatId}`] || null;
}
function setBotLang(companyId, chatId, lang) {
  botLang[`${companyId}:${chatId}`] = lang;
  saveBotLang(botLang);
}

// ---------- Traductions du bot Telegram (FR / EN / ES) ----------
const BOT_I18N = {
  fr: {
    lang_set: "✅ Langue réglée sur Français.",
    welcome: "Bienvenue chez *{{COMPANY_NAME}}* 🚗🔧\nQue souhaitez-vous faire ?",
    menu_book: "📅 Réserver un rendez-vous",
    menu_verify: "🔍 Vérifier l'état d'une voiture avant achat",
    menu_track: "🔑 Suivre l'état de ma voiture avec le code",
    start_hint: "Bonjour ! Envoyez /start pour commencer 🚗",
    ask_name: "Je vais vous réserver un rendez-vous. D'abord, quel est votre nom complet ?",
    ask_phone: "Quel est votre numéro de téléphone ? (pour pouvoir vous contacter)",
    invalid_phone: "Ce numéro ne semble pas valide 🙏 Merci de le saisir correctement (ex : 0600000000)",
    ask_car: "Quel est le modèle de votre voiture ? (ex : Toyota Corolla 2018)",
    ask_which_day_verif: "Quel jour souhaitez-vous venir pour la vérification ?\n{list}\n\nEnvoyez le numéro du jour.",
    ask_issue: "Quel est le problème sur la voiture ? (description courte)",
    ask_which_service: "Quel service souhaitez-vous ?\n{list}\n\nEnvoyez le numéro du service.",
    invalid_service_number: "Merci d'envoyer un numéro valide de la liste (1-{max})",
    ask_which_day: "Quel jour souhaitez-vous pour le rendez-vous ?\n{list}\n\nEnvoyez le numéro du jour.",
    invalid_day_number: "Merci d'envoyer un numéro valide de la liste (1-{max})",
    day_full: "Désolé, il n'y a plus aucun créneau disponible le {day} 🙏\n\nQue préférez-vous ?\n1. Choisir un autre jour\n2. M'inscrire sur la liste d'attente (on vous contactera dès qu'un créneau se libère)\n\nEnvoyez le numéro de votre choix.",
    invalid_choice_12: "Merci d'envoyer 1 ou 2 🙏",
    waitlist_registered: "✅ Vous êtes inscrit sur la liste d'attente ! On vous contactera dès qu'un créneau se libère 🙏",
    ask_which_time: "À quelle heure préférez-vous ?\n{list}\n\nEnvoyez le numéro de l'heure.",
    invalid_time_number: "Merci d'envoyer un numéro valide de la liste.",
    appt_confirmed: "✅ Votre rendez-vous est confirmé !\n\n👤 {name}\n📞 {phone}\n🚗 {car}\n🔧 {service}\n📅 {date}\n🕐 {time}\n\n🔑 Votre code de suivi : *{code}*\n(gardez-le, il vous sera redemandé)\n\nOn vous attend chez {{COMPANY_NAME}} !",
    copy_code: "📋 Copier le code",
    what_now: "Que souhaitez-vous faire maintenant ? 👇",
    ask_track_code: "Entrez votre code de suivi (6 chiffres) :",
    code_must_be_6: "Le code de suivi doit être composé de 6 chiffres exactement 🙏 Réessayez :",
    no_appt_for_code: "Aucun rendez-vous trouvé avec ce code 🤔 Vérifiez-le ou contactez {{COMPANY_NAME}}.",
    please_choose_menu: "Merci de choisir une option dans le menu ci-dessous 👇",
    status_track_title: "🔑 Code de suivi : *{code}*",
    status_not_assigned: "Non assigné pour le moment",
    status_pending_txt: "🟡 En attente",
    status_inprogress_txt: "🔧 En cours de réparation",
    status_done_txt: "✅ Terminée — disponible",
    status_cancelled_txt: "❌ Rendez-vous annulé",
    status_done_extra: "\n\nVotre voiture est prête, vous pouvez venir la récupérer 🎉",
    notify_inprogress: "🔧 Bonjour {name}, nous avons commencé l'intervention sur votre voiture ({car}).\n\n🔑 Code de suivi : {code}",
    notify_done: "✅ Bonjour {name}, votre voiture ({car}) est prête ! Vous pouvez venir la récupérer.\n\n🔑 Code de suivi : {code}",
    notify_cancelled: "❌ Bonjour {name}, votre rendez-vous du {date} — {time} a été annulé. Contactez-nous si vous souhaitez reprendre rendez-vous.",
    slot_freed: "🎉 Un créneau s'est libéré ! Vous pouvez réserver le {date} — {time}. Envoyez /rdv pour réserver rapidement.",
    reminder: "⏰ Rappel : vous avez rendez-vous demain ({date} — {time}) chez {{COMPANY_NAME}}\n🚗 {car}\n🔧 {service}\n\nÀ bientôt !",
    invoice_caption: "🧾 Votre facture pour {car}\nTotal : {price} {currency}\n\nMerci de votre confiance envers {{COMPANY_NAME}} ! 🙏",
    today: "aujourd'hui",
    tomorrow: "demain",
    day_after_tomorrow: "après-demain",
  },
  en: {
    lang_set: "✅ Language set to English.",
    welcome: "Welcome to *{{COMPANY_NAME}}* 🚗🔧\nWhat would you like to do?",
    menu_book: "📅 Book a repair appointment",
    menu_verify: "🔍 Check a car's condition before buying",
    menu_track: "🔑 Track my car's status with my code",
    start_hint: "Hello! Send /start to begin 🚗",
    ask_name: "Let's book you an appointment. First, what is your full name?",
    ask_phone: "What is your phone number? (so we can contact you)",
    invalid_phone: "That number doesn't look valid 🙏 Please enter it correctly (e.g. 0600000000)",
    ask_car: "What is your car model? (e.g. Toyota Corolla 2018)",
    ask_which_day_verif: "Which day would you like to come for the inspection?\n{list}\n\nSend the day's number.",
    ask_issue: "What's the problem with the car? (short description)",
    ask_which_service: "Which service would you like?\n{list}\n\nSend the service number.",
    invalid_service_number: "Please send a valid number from the list (1-{max})",
    ask_which_day: "Which day would you like for the appointment?\n{list}\n\nSend the day's number.",
    invalid_day_number: "Please send a valid number from the list (1-{max})",
    day_full: "Sorry, there are no more slots available on {day} 🙏\n\nWhat would you like to do?\n1. Choose another day\n2. Join the waitlist (we'll contact you as soon as a slot opens up)\n\nSend the number of your choice.",
    invalid_choice_12: "Please send 1 or 2 🙏",
    waitlist_registered: "✅ You're on the waitlist! We'll contact you as soon as a slot opens up 🙏",
    ask_which_time: "What time would you prefer?\n{list}\n\nSend the time's number.",
    invalid_time_number: "Please send a valid number from the list.",
    appt_confirmed: "✅ Your appointment is confirmed!\n\n👤 {name}\n📞 {phone}\n🚗 {car}\n🔧 {service}\n📅 {date}\n🕐 {time}\n\n🔑 Your tracking code: *{code}*\n(keep it, you'll be asked for it later)\n\nWe look forward to seeing you at {{COMPANY_NAME}}!",
    copy_code: "📋 Copy code",
    what_now: "What would you like to do now? 👇",
    ask_track_code: "Enter your tracking code (6 digits):",
    code_must_be_6: "The tracking code must be exactly 6 digits 🙏 Try again:",
    no_appt_for_code: "No appointment found with this code 🤔 Double-check it or contact {{COMPANY_NAME}}.",
    please_choose_menu: "Please choose an option from the menu below 👇",
    status_track_title: "🔑 Tracking code: *{code}*",
    status_not_assigned: "Not assigned yet",
    status_pending_txt: "🟡 Pending",
    status_inprogress_txt: "🔧 Currently being repaired",
    status_done_txt: "✅ Done — ready for pickup",
    status_cancelled_txt: "❌ Appointment cancelled",
    status_done_extra: "\n\nYour car is ready, you can come pick it up 🎉",
    notify_inprogress: "🔧 Hi {name}, we've started working on your car ({car}).\n\n🔑 Tracking code: {code}",
    notify_done: "✅ Hi {name}, your car ({car}) is ready! You can come pick it up.\n\n🔑 Tracking code: {code}",
    notify_cancelled: "❌ Hi {name}, your appointment on {date} — {time} has been cancelled. Contact us if you'd like to rebook.",
    slot_freed: "🎉 A slot just opened up! You can book {date} — {time}. Send /rdv to book quickly.",
    reminder: "⏰ Reminder: you have an appointment tomorrow ({date} — {time}) at {{COMPANY_NAME}}\n🚗 {car}\n🔧 {service}\n\nSee you soon!",
    invoice_caption: "🧾 Your invoice for {car}\nTotal: {price} {currency}\n\nThank you for trusting {{COMPANY_NAME}}! 🙏",
    today: "today",
    tomorrow: "tomorrow",
    day_after_tomorrow: "the day after tomorrow",
  },
  es: {
    lang_set: "✅ Idioma configurado en Español.",
    welcome: "Bienvenido a *{{COMPANY_NAME}}* 🚗🔧\n¿Qué te gustaría hacer?",
    menu_book: "📅 Reservar una cita de reparación",
    menu_verify: "🔍 Verificar el estado de un coche antes de comprar",
    menu_track: "🔑 Seguir el estado de mi coche con mi código",
    start_hint: "¡Hola! Envía /start para comenzar 🚗",
    ask_name: "Vamos a reservarte una cita. Primero, ¿cuál es tu nombre completo?",
    ask_phone: "¿Cuál es tu número de teléfono? (para poder contactarte)",
    invalid_phone: "Ese número no parece válido 🙏 Escríbelo correctamente (ej: 0600000000)",
    ask_car: "¿Cuál es el modelo de tu coche? (ej: Toyota Corolla 2018)",
    ask_which_day_verif: "¿Qué día te gustaría venir para la verificación?\n{list}\n\nEnvía el número del día.",
    ask_issue: "¿Cuál es el problema del coche? (descripción breve)",
    ask_which_service: "¿Qué servicio te gustaría?\n{list}\n\nEnvía el número del servicio.",
    invalid_service_number: "Envía un número válido de la lista (1-{max})",
    ask_which_day: "¿Qué día te gustaría para la cita?\n{list}\n\nEnvía el número del día.",
    invalid_day_number: "Envía un número válido de la lista (1-{max})",
    day_full: "Lo sentimos, no quedan horarios disponibles el {day} 🙏\n\n¿Qué prefieres?\n1. Elegir otro día\n2. Apuntarme a la lista de espera (te contactaremos en cuanto se libere un horario)\n\nEnvía el número de tu elección.",
    invalid_choice_12: "Envía 1 o 2 🙏",
    waitlist_registered: "✅ ¡Estás en la lista de espera! Te contactaremos en cuanto se libere un horario 🙏",
    ask_which_time: "¿A qué hora prefieres?\n{list}\n\nEnvía el número de la hora.",
    invalid_time_number: "Envía un número válido de la lista.",
    appt_confirmed: "✅ ¡Tu cita está confirmada!\n\n👤 {name}\n📞 {phone}\n🚗 {car}\n🔧 {service}\n📅 {date}\n🕐 {time}\n\n🔑 Tu código de seguimiento: *{code}*\n(guárdalo, te lo pediremos más adelante)\n\n¡Te esperamos en {{COMPANY_NAME}}!",
    copy_code: "📋 Copiar código",
    what_now: "¿Qué te gustaría hacer ahora? 👇",
    ask_track_code: "Introduce tu código de seguimiento (6 dígitos):",
    code_must_be_6: "El código de seguimiento debe tener exactamente 6 dígitos 🙏 Inténtalo de nuevo:",
    no_appt_for_code: "No se encontró ninguna cita con este código 🤔 Verifícalo o contacta con {{COMPANY_NAME}}.",
    please_choose_menu: "Por favor elige una opción del menú de abajo 👇",
    status_track_title: "🔑 Código de seguimiento: *{code}*",
    status_not_assigned: "Aún sin asignar",
    status_pending_txt: "🟡 En espera",
    status_inprogress_txt: "🔧 En reparación",
    status_done_txt: "✅ Terminada — lista para recoger",
    status_cancelled_txt: "❌ Cita cancelada",
    status_done_extra: "\n\nTu coche está listo, puedes venir a recogerlo 🎉",
    notify_inprogress: "🔧 Hola {name}, hemos comenzado a trabajar en tu coche ({car}).\n\n🔑 Código de seguimiento: {code}",
    notify_done: "✅ Hola {name}, ¡tu coche ({car}) está listo! Puedes venir a recogerlo.\n\n🔑 Código de seguimiento: {code}",
    notify_cancelled: "❌ Hola {name}, tu cita del {date} — {time} ha sido cancelada. Contáctanos si deseas reagendar.",
    slot_freed: "🎉 ¡Se ha liberado un horario! Puedes reservar el {date} — {time}. Envía /rdv para reservar rápidamente.",
    reminder: "⏰ Recordatorio: tienes una cita mañana ({date} — {time}) en {{COMPANY_NAME}}\n🚗 {car}\n🔧 {service}\n\n¡Hasta pronto!",
    invoice_caption: "🧾 Tu factura de {car}\nTotal: {price} {currency}\n\n¡Gracias por confiar en {{COMPANY_NAME}}! 🙏",
    today: "hoy",
    tomorrow: "mañana",
    day_after_tomorrow: "pasado mañana",
  },
};
function bt(companyId, chatId, key, vars) {
  const lang = getBotLang(companyId, chatId) || "fr";
  let s = (BOT_I18N[lang] && BOT_I18N[lang][key]) || BOT_I18N.fr[key] || key;
  if (vars) Object.keys(vars).forEach((k) => { s = s.split("{" + k + "}").join(vars[k]); });
  const c = getCompany(companyId) || companies[0];
  return s.replaceAll("{{COMPANY_NAME}}", c.name);
}
function botMainMenu(companyId, chatId) {
  return {
    reply_markup: {
      keyboard: [
        [bt(companyId, chatId, "menu_book")],
        [bt(companyId, chatId, "menu_verify")],
        [bt(companyId, chatId, "menu_track")],
      ],
      resize_keyboard: true,
    },
  };
}
function botServiceLabel(companyId, chatId, name) {
  const lang = getBotLang(companyId, chatId) || "fr";
  const map = {
    en: { "Vidange + Filtre": "Oil & filter change", "Diagnostic moteur": "Engine diagnostic", "Freinage complet": "Full brake service", "Révision complète": "Full service", "Suspension": "Suspension", "Autre": "Other", "Vérification état avant achat": "Pre-purchase inspection" },
    es: { "Vidange + Filtre": "Cambio de aceite y filtro", "Diagnostic moteur": "Diagnóstico del motor", "Freinage complet": "Frenos completos", "Révision complète": "Revisión completa", "Suspension": "Suspensión", "Autre": "Otro", "Vérification état avant achat": "Inspección antes de comprar" },
  };
  return (map[lang] && map[lang][name]) || name;
}

// ---------- Traductions pour les PDF (factures, fiches véhicule) FR / EN / ES ----------
const PDF_I18N = {
  fr: {
    invoice: "Facture", invoice_no: "N° Facture", date: "Date", client: "Client", phone: "Téléphone",
    vehicle: "Véhicule", service: "Service", total: "Total", not_found_invoice: "Facture introuvable",
    appt_list_title: "Liste des rendez-vous — généré le", not_found_appt: "Rendez-vous introuvable",
    problem: "Problème", employee: "Employé", status: "Statut", date_time: "Date/Heure", no_appt: "Aucun rendez-vous pour le moment.",
    work_order: "Fiche véhicule / Bon de travail", tracking_code: "Code de suivi", hour: "Heure",
    client_section: "Client", vehicle_section: "Véhicule", intervention_section: "Intervention",
    name: "Nom", reported_problem: "Problème signalé", assigned_employee: "Employé assigné", unassigned: "Non assigné",
    generated_on: "Généré le", locale: "fr-FR",
    status_map: { "En attente": "En attente", "En cours": "En cours", "Terminé": "Terminé", "Annulé": "Annulé" },
  },
  en: {
    invoice: "Invoice", invoice_no: "Invoice No.", date: "Date", client: "Client", phone: "Phone",
    vehicle: "Vehicle", service: "Service", total: "Total", not_found_invoice: "Invoice not found",
    appt_list_title: "Appointment list — generated on", not_found_appt: "Appointment not found",
    problem: "Problem", employee: "Employee", status: "Status", date_time: "Date/Time", no_appt: "No appointments yet.",
    work_order: "Vehicle sheet / Work order", tracking_code: "Tracking code", hour: "Time",
    client_section: "Client", vehicle_section: "Vehicle", intervention_section: "Service",
    name: "Name", reported_problem: "Reported problem", assigned_employee: "Assigned employee", unassigned: "Unassigned",
    generated_on: "Generated on", locale: "en-GB",
    status_map: { "En attente": "Pending", "En cours": "In progress", "Terminé": "Done", "Annulé": "Cancelled" },
  },
  es: {
    invoice: "Factura", invoice_no: "N.º de factura", date: "Fecha", client: "Cliente", phone: "Teléfono",
    vehicle: "Vehículo", service: "Servicio", total: "Total", not_found_invoice: "Factura no encontrada",
    appt_list_title: "Lista de citas — generado el", not_found_appt: "Cita no encontrada",
    problem: "Problema", employee: "Empleado", status: "Estado", date_time: "Fecha/Hora", no_appt: "Sin citas por el momento.",
    work_order: "Ficha de vehículo / Orden de trabajo", tracking_code: "Código de seguimiento", hour: "Hora",
    client_section: "Cliente", vehicle_section: "Vehículo", intervention_section: "Intervención",
    name: "Nombre", reported_problem: "Problema reportado", assigned_employee: "Empleado asignado", unassigned: "Sin asignar",
    generated_on: "Generado el", locale: "es-ES",
    status_map: { "En attente": "En espera", "En cours": "En curso", "Terminé": "Terminado", "Annulé": "Cancelado" },
  },
};
function pdfLang(req) {
  const l = String((req && req.query && req.query.lang) || "fr").toLowerCase();
  return PDF_I18N[l] ? l : "fr";
}
function pt(lang, key) {
  return (PDF_I18N[lang] && PDF_I18N[lang][key]) || PDF_I18N.fr[key] || key;
}
function pdfStatus(lang, status) {
  return (PDF_I18N[lang].status_map && PDF_I18N[lang].status_map[status]) || status || "-";
}
function pdfServiceLabel(lang, name) {
  const map = {
    en: { "Vidange + Filtre": "Oil & filter change", "Vidange & Filtre": "Oil & filter change", "Diagnostic moteur": "Engine diagnostic", "Diagnostic électronique": "Electronic diagnostic", "Freinage complet": "Full brake service", "Révision complète": "Full service", "Suspension": "Suspension", "Autre": "Other", "Vérification état avant achat": "Pre-purchase inspection" },
    es: { "Vidange + Filtre": "Cambio de aceite y filtro", "Vidange & Filtre": "Cambio de aceite y filtro", "Diagnostic moteur": "Diagnóstico del motor", "Diagnostic électronique": "Diagnóstico electrónico", "Freinage complet": "Frenos completos", "Révision complète": "Revisión completa", "Suspension": "Suspensión", "Autre": "Otro", "Vérification état avant achat": "Inspección antes de comprar" },
  };
  return (map[lang] && map[lang][name]) || name;
}

// ---------- الخدمات و الأوقات المتاحة ----------
const SERVICES = [
  "Vidange + Filtre",
  "Diagnostic moteur",
  "Freinage complet",
  "Révision complète",
  "Suspension",
  "Autre",
];
const SLOTS = ["09:00", "10:30", "12:00", "14:00", "15:30", "17:00"];

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}
function dateLabel(offsetDays, companyId, chatId) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const iso = toISODate(d);
  const lang = (chatId && getBotLang(companyId, chatId)) || "fr";
  const localeMap = { fr: "fr-FR", en: "en-GB", es: "es-ES" };
  const dayKeys = ["today", "tomorrow", "day_after_tomorrow"];
  const label = dayKeys[offsetDays] ? bt(companyId, chatId || 0, dayKeys[offsetDays]) : d.toLocaleDateString(localeMap[lang]);
  return { iso, label: `${label} (${d.toLocaleDateString(localeMap[lang])})` };
}
function prochainesDates(companyId, chatId) {
  return [dateLabel(0, companyId, chatId), dateLabel(1, companyId, chatId), dateLabel(2, companyId, chatId)];
}
function slotsDisponibles(date, companyId = companies[0].id) {
  const prisPar = new Set(
    appointments.filter((a) => String(a.companyId || "company_default") === String(companyId) && a.date === date).map((a) => a.time)
  );
  return SLOTS.filter((s) => !prisPar.has(s));
}

// ---------- رقم تتبع فريد (6 أرقام) — ماكايتكررش أبدا ----------
function generateUniqueCode() {
  const existants = new Set(appointments.map((a) => a.code).filter(Boolean));
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (existants.has(code));
  return code;
}

// ---------- Bot manager: بوت Telegram مستقل بوحدو لكل ورشة (توكن خاص بكل واحدة) ----------
const runningBots = {}; // companyId -> { bot, sessions, reminderInterval }

function stopCompanyBot(companyId) {
  const entry = runningBots[String(companyId)];
  if (!entry) return;
  try { entry.bot.stopPolling(); } catch {}
  delete runningBots[String(companyId)];
  console.log(`⏹️  بوت الورشة #${companyId} توقف.`);
}

function startCompanyBot(company) {
  if (!company || !company.telegramBotToken || company.active === false) return;
  stopCompanyBot(company.id);

  const companyId = company.id;
  const sessions = {}; // chatId -> { step, data, flow } — معزولة لهاد الورشة بوحدها

  let bot;
  try {
    bot = new TelegramBot(company.telegramBotToken, { polling: true });
  } catch (e) {
    console.error(`❌ ماقدرش يبدا بوت الورشة "${company.name}" — تأكد من التوكن:`, e.message);
    return;
  }
  bot.on("polling_error", (e) => console.error(`⚠️ Polling error (${company.name}):`, e.message));

  function cc() { return getCompany(companyId) || company; } // آخر نسخة محدثة ديال الورشة

  function reset(chatId) { sessions[chatId] = { step: "menu", data: {}, flow: null }; }

  const LANG_KEYBOARD = { reply_markup: { inline_keyboard: [[{ text: "🇫🇷 Français", callback_data: "lang_fr" }, { text: "🇬🇧 English", callback_data: "lang_en" }, { text: "🇪🇸 Español", callback_data: "lang_es" }]] } };
  function sendLangPicker(chatId) { bot.sendMessage(chatId, "🇫🇷 Choisissez votre langue\n🇬🇧 Choose your language\n🇪🇸 Elige tu idioma", LANG_KEYBOARD); }

  function phoneValide(text) { const clean = text.replace(/[\s\-]/g, ""); return /^\+?\d{9,14}$/.test(clean); }

  function messageHalaSayara(appt, chatId) {
    const terminee = appt.status === "Terminé";
    const annulee = appt.status === "Annulé";
    let etat = bt(companyId, chatId, "status_pending_txt");
    if (appt.status === "En cours") etat = bt(companyId, chatId, "status_inprogress_txt");
    if (terminee) etat = bt(companyId, chatId, "status_done_txt");
    if (annulee) etat = bt(companyId, chatId, "status_cancelled_txt");
    let msg = bt(companyId, chatId, "status_track_title", { code: appt.code }) + "\n\n";
    msg += `👤 ${appt.name}\n🚗 ${appt.car}\n📅 ${appt.date} — 🕐 ${appt.time}\n\n`;
    msg += `${appt.issue || "-"}\n`;
    msg += `🔧 ${botServiceLabel(companyId, chatId, appt.service)}\n`;
    msg += `👨‍🔧 ${appt.employee || bt(companyId, chatId, "status_not_assigned")}\n\n`;
    msg += etat;
    if (terminee) msg += bt(companyId, chatId, "status_done_extra");
    return msg;
  }

  bot.on("callback_query", (query) => {
    const chatId = query.message.chat.id;
    const data = query.data || "";
    if (data === "owner_register") {
      cc().telegramChatId = String(chatId);
      saveJson(COMPANIES_FILE, companies);
      bot.answerCallbackQuery(query.id, { text: "Notifications activées ✓" }).catch(() => {});
      bot.sendMessage(chatId, `✅ هاد الشات دابا غادي يتوصل بتنبيهات المواعيد الجداد ديال *${cc().name}*.`, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    if (data.startsWith("lang_")) {
      const lang = data.replace("lang_", "");
      if (["fr", "en", "es"].includes(lang)) {
        setBotLang(companyId, chatId, lang);
        bot.answerCallbackQuery(query.id).catch(() => {});
        reset(chatId);
        bot.sendMessage(chatId, bt(companyId, chatId, "lang_set"));
        bot.sendMessage(chatId, bt(companyId, chatId, "welcome"), { parse_mode: "Markdown", ...botMainMenu(companyId, chatId) });
      }
    }
  });

  bot.onText(/\/language|\/lang/i, (msg) => sendLangPicker(msg.chat.id));

  // ---- /owner : صاحب الورشة كيصيفطها هو بوحدو باش يربط الشات ديالو للتنبيهات ----
  bot.onText(/\/owner/i, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🔐 إلا كنتي صاحب/مسؤول *${cc().name}*، ضغط على الزر باش تبدا تتوصل بتنبيهات المواعيد الجداد فهاد الشات.`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "✅ فعّل التنبيهات هنا", callback_data: "owner_register" }]] },
    });
  });

  bot.onText(/\/start/i, (msg) => {
    const chatId = msg.chat.id;
    reset(chatId);
    if (!getBotLang(companyId, chatId)) { sendLangPicker(chatId); return; }
    bot.sendMessage(chatId, bt(companyId, chatId, "welcome"), { parse_mode: "Markdown", ...botMainMenu(companyId, chatId) });
  });

  bot.onText(/\/rdv|موعد/i, (msg) => {
    const chatId = msg.chat.id;
    if (!getBotLang(companyId, chatId)) { sendLangPicker(chatId); return; }
    sessions[chatId] = { step: "name", data: {}, flow: "rdv" };
    bot.sendMessage(chatId, bt(companyId, chatId, "ask_name"), { reply_markup: { remove_keyboard: true } });
  });

  bot.onText(/\/track/i, (msg) => {
    const chatId = msg.chat.id;
    if (!getBotLang(companyId, chatId)) { sendLangPicker(chatId); return; }
    sessions[chatId] = { step: "track_code", data: {}, flow: "track" };
    bot.sendMessage(chatId, bt(companyId, chatId, "ask_track_code"), { reply_markup: { remove_keyboard: true } });
  });

  bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();
    if (!text || text.startsWith("/")) return;
    if (!getBotLang(companyId, chatId)) { sendLangPicker(chatId); return; }
    if (!sessions[chatId]) { reset(chatId); bot.sendMessage(chatId, bt(companyId, chatId, "start_hint"), botMainMenu(companyId, chatId)); return; }
    const session = sessions[chatId];

    if (session.step === "menu") {
      if (/^\d{6}$/.test(text)) {
        const appt = appointments.find((a) => a.code === text && String(a.companyId || "company_default") === String(companyId));
        if (!appt) bot.sendMessage(chatId, bt(companyId, chatId, "no_appt_for_code"), botMainMenu(companyId, chatId));
        else bot.sendMessage(chatId, messageHalaSayara(appt, chatId), { parse_mode: "Markdown", ...botMainMenu(companyId, chatId) });
        return;
      }
      if (text === bt(companyId, chatId, "menu_book")) {
        session.flow = "rdv"; session.step = "name";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_name"), { reply_markup: { remove_keyboard: true } });
      } else if (text === bt(companyId, chatId, "menu_verify")) {
        session.flow = "verification"; session.step = "name";
        bot.sendMessage(chatId, bt(companyId, chatId, "menu_verify") + " ✅\n" + bt(companyId, chatId, "ask_name"), { reply_markup: { remove_keyboard: true } });
      } else if (text === bt(companyId, chatId, "menu_track")) {
        session.flow = "track"; session.step = "track_code";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_track_code"), { reply_markup: { remove_keyboard: true } });
      } else {
        bot.sendMessage(chatId, bt(companyId, chatId, "please_choose_menu"), botMainMenu(companyId, chatId));
      }
      return;
    }

    if (session.step === "track_code") {
      const code = text.replace(/\s/g, "");
      if (!/^\d{6}$/.test(code)) { bot.sendMessage(chatId, bt(companyId, chatId, "code_must_be_6")); return; }
      const appt = appointments.find((a) => a.code === code && String(a.companyId || "company_default") === String(companyId));
      if (!appt) { bot.sendMessage(chatId, bt(companyId, chatId, "no_appt_for_code"), botMainMenu(companyId, chatId)); delete sessions[chatId]; return; }
      bot.sendMessage(chatId, messageHalaSayara(appt, chatId), { parse_mode: "Markdown", ...botMainMenu(companyId, chatId) });
      delete sessions[chatId];
      return;
    }

    switch (session.step) {
      case "name":
        session.data.name = text; session.step = "phone";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_phone"));
        break;
      case "phone":
        if (!phoneValide(text)) { bot.sendMessage(chatId, bt(companyId, chatId, "invalid_phone")); return; }
        session.data.phone = text.trim(); session.step = "car";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_car"));
        break;
      case "car":
        session.data.car = text;
        if (session.flow === "verification") {
          session.step = "date";
          const dates = prochainesDates(companyId, chatId);
          session.data.dateOptions = dates;
          session.data.service = "Vérification état avant achat";
          session.data.issue = "-";
          bot.sendMessage(chatId, bt(companyId, chatId, "ask_which_day_verif", { list: dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") }));
        } else {
          session.step = "issue";
          bot.sendMessage(chatId, bt(companyId, chatId, "ask_issue"));
        }
        break;
      case "issue":
        session.data.issue = text; session.step = "service";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_which_service", { list: SERVICES.map((s, i) => `${i + 1}. ${botServiceLabel(companyId, chatId, s)}`).join("\n") }));
        break;
      case "service": {
        const idx = parseInt(text, 10) - 1;
        const service = SERVICES[idx];
        if (!service) { bot.sendMessage(chatId, bt(companyId, chatId, "invalid_service_number", { max: SERVICES.length })); return; }
        session.data.service = service; session.step = "date";
        const dates = prochainesDates(companyId, chatId);
        session.data.dateOptions = dates;
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_which_day", { list: dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") }));
        break;
      }
      case "date": {
        const idx = parseInt(text, 10) - 1;
        const chosen = session.data.dateOptions[idx];
        if (!chosen) { bot.sendMessage(chatId, bt(companyId, chatId, "invalid_day_number", { max: session.data.dateOptions.length })); return; }
        session.data.date = chosen.iso;
        const dispo = slotsDisponibles(chosen.iso, companyId);
        if (dispo.length === 0) { session.step = "date_full"; bot.sendMessage(chatId, bt(companyId, chatId, "day_full", { day: chosen.label })); return; }
        session.step = "time";
        bot.sendMessage(chatId, bt(companyId, chatId, "ask_which_time", { list: dispo.map((s, i) => `${i + 1}. ${s}`).join("\n") }));
        break;
      }
      case "date_full": {
        if (text.trim() === "1") {
          session.step = "date";
          const dates = prochainesDates(companyId, chatId);
          session.data.dateOptions = dates;
          bot.sendMessage(chatId, bt(companyId, chatId, "ask_which_day", { list: dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") }));
        } else if (text.trim() === "2") {
          const entry = { companyId, id: Date.now(), name: session.data.name, phone: session.data.phone || "", car: session.data.car, issue: session.data.issue || "-", service: session.data.service, preferredDate: session.data.date, createdAt: toISODate(new Date()), source: "Telegram", chatId };
          waitlist.push(entry); saveWaitlist(waitlist);
          notifyOwner(`⏳ *تسجيل جديد فلائحة الانتظار*\n\n👤 ${entry.name}\n📞 ${entry.phone || "-"}\n🚗 ${entry.car}\n🔧 ${entry.service}\n📅 اليوم المفضل: ${entry.preferredDate}`, companyId);
          bot.sendMessage(chatId, bt(companyId, chatId, "waitlist_registered"), botMainMenu(companyId, chatId));
          delete sessions[chatId];
        } else {
          bot.sendMessage(chatId, bt(companyId, chatId, "invalid_choice_12"));
        }
        break;
      }
      case "time": {
        const dispo = slotsDisponibles(session.data.date, companyId);
        const idx = parseInt(text, 10) - 1;
        const time = dispo[idx];
        if (!time) { bot.sendMessage(chatId, bt(companyId, chatId, "invalid_time_number")); return; }
        const appt = { companyId, id: Date.now(), code: generateUniqueCode(), date: session.data.date, time, name: session.data.name, phone: session.data.phone || "", car: session.data.car, issue: session.data.issue || "-", service: session.data.service, status: "En attente", employee: "", source: "Telegram", chatId, photosBefore: [], photosAfter: [], parts: [], reminderSent: false };
        appointments.push(appt); saveAppointments(appointments);
        notifyOwnerNewAppointment(appt);
        bot.sendMessage(chatId, bt(companyId, chatId, "appt_confirmed", { name: appt.name, phone: appt.phone, car: appt.car, service: botServiceLabel(companyId, chatId, appt.service), date: appt.date, time: appt.time, code: appt.code }), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: bt(companyId, chatId, "copy_code"), copy_text: { text: appt.code } }]] },
        }).then(() => bot.sendMessage(chatId, bt(companyId, chatId, "what_now"), botMainMenu(companyId, chatId)));
        delete sessions[chatId];
        break;
      }
    }
  });

  runningBots[String(companyId)] = { bot, sessions };
  console.log(`✅ بوت تيليغرام خدام للورشة "${company.name}" (#${companyId})`);
}

// ---------- تنبيه صاحب الورشة فتيليغرام ملي يجي موعد جديد ----------
function notifyOwner(text, companyId) {
  const c = getCompany(companyId);
  const entry = runningBots[String(companyId)];
  if (!c?.telegramChatId || !entry) return;
  entry.bot.sendMessage(c.telegramChatId, String(text ?? "").replaceAll("{{COMPANY_NAME}}", c.name), { parse_mode: "Markdown" }).catch((e) => {
    console.error(`❌ Telegram owner notification failed for ${c?.name || companyId}:`, e.message);
  });
}
function notifyOwnerNewAppointment(appt) {
  notifyOwner(
    `🆕 *موعد جديد!*\n\n👤 ${appt.name}\n📞 ${appt.phone || "-"}\n🚗 ${appt.car}\n🔧 ${appt.service}\n📅 ${appt.date} — 🕐 ${appt.time}\n📝 ${appt.issue || "-"}\n\n🔑 كود: ${appt.code || "-"}\n📍 مصدر: ${appt.source || "-"}`,
    appt.companyId
  );
}

// ---------- توصل تلقائي للزبون ملي الحالة ديال الموعد كتبدل (En cours / Terminé / Annulé) ----------
function notifyCustomerStatusChange(appt, oldStatus) {
  const notifiableStatuses = ["En cours", "Terminé", "Annulé"];
  if (!notifiableStatuses.includes(appt.status) || appt.status === oldStatus) return;
  const chatIdForLang = appt.chatId || 0;
  const companyId = appt.companyId;
  const statusMsgs = {
    "En cours": bt(companyId, chatIdForLang, "notify_inprogress", { name: appt.name, car: appt.car, code: appt.code || "-" }),
    Terminé: bt(companyId, chatIdForLang, "notify_done", { name: appt.name, car: appt.car, code: appt.code || "-" }),
    Annulé: bt(companyId, chatIdForLang, "notify_cancelled", { date: appt.date, time: appt.time }),
  };
  const text = statusMsgs[appt.status];
  const entry = runningBots[String(companyId)];
  if (appt.chatId && entry) {
    entry.bot.sendMessage(appt.chatId, text, { parse_mode: "Markdown" }).catch((e) => {
      console.error("❌ ماقدرش يصيفط توصل تيليغرام للزبون:", e.message);
    });
  } else if (appt.phone) {
    sendWhatsAppOrSMS(appt.phone, `${companyOf(companyId).name}\n\n${text}`);
  }

  if (appt.status === "Terminé") {
    const inv = invoices.find((i) => Number(i.appointmentId) === Number(appt.id));
    if (inv) sendInvoiceToCustomer(inv, appt);
  }
}

// ---------- SMS / WhatsApp تلقائي للزبون (Twilio، اختياري) ----------
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require("twilio")(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error("⚠️ Twilio ماكاينش مثبت (npm install twilio) — SMS/WhatsApp غادي يكون معطل.");
  }
}
function toE164(phone) {
  let p = (phone || "").replace(/[\s\-]/g, "");
  if (!p) return "";
  if (p.startsWith("0")) p = "+212" + p.slice(1); // المغرب بحال default
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}
async function sendWhatsAppOrSMS(phone, text) {
  if (!twilioClient || !phone) return;
  const to = toE164(phone);
  try {
    if (TWILIO_WHATSAPP_FROM) {
      await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to: `whatsapp:${to}`, body: text });
      return;
    }
  } catch (e) {
    console.error("⚠️ WhatsApp ماخدمش، كنجربو SMS:", e.message);
  }
  try {
    if (TWILIO_SMS_FROM) {
      await twilioClient.messages.create({ from: TWILIO_SMS_FROM, to, body: text });
    }
  } catch (e) {
    console.error("❌ ماقدرش يصيفط SMS:", e.message);
  }
}

// ---------- API باش الصفحة تقرا/تزيد المواعيد ----------
const app = express();
app.use(express.json());
// مهم: express.static خاصو يكون قبل حاجز الحماية (auth gate)، حيت صفحة العامل (employee.html)
// كتحتاج تحمل /i18n.js و/mr-garage-logo.png بلا ما يكون عندها الكوكي ديال صاحب الورشة.
// المعطيات الحساسة كاملة محمية عبر /api/* بوحدها، فهاد الشي بلا خطر.
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR)); // صور السيارات واللوغوهات — عمومية بلا تسجيل دخول (بلا معطيات حساسة)

// --- حماية بسيطة بكلمة سر (كوكي) ---
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((c) => {
    const [k, ...v] = c.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  });
  return out;
}

// ---------- Espace employés: route publique + session مستقلة ----------
app.get("/employee", (req, res) => {
  res.sendFile(path.join(__dirname, "employee.html"));
});

app.get("/employee/login", (req, res) => {
  res.redirect("/employee");
});

app.post("/employee/login", (req, res) => {
  const login = String(req.body?.login || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const companyUsername = String(req.body?.companyUsername || "").trim().toLowerCase();
  if (!login || !password || !companyUsername) return res.status(400).json({ error: "MISSING_CREDENTIALS" });
  const company = companies.find(c => String(c.username || "").trim().toLowerCase() === companyUsername && c.active !== false);
  if (!company) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const emp = employees.find(e => String(e.companyId || "company_default") === String(company.id) && String(e.login ?? e.username ?? e.user ?? "").trim().toLowerCase() === login);
  if (!emp) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  if (emp.active === false || emp.disabled === true) return res.status(403).json({ error: "ACCOUNT_DISABLED" });

  let valid = verifyEmployeePassword(password, emp);

  // دعم الحسابات القديمة إذا كان عندك موظفين تسجلو قبل إضافة النظام الجديد.
  // منين ينجح الدخول، كنحوّل password القديم تلقائياً إلى hash آمن.
  const legacyPassword = emp.password ?? emp.pass ?? emp.passwordPlain;
  if (!valid && legacyPassword !== undefined && String(legacyPassword) === password) {
    const { salt, hash } = hashEmployeePassword(password);
    emp.passwordSalt = salt;
    emp.passwordHash = hash;
    delete emp.password;
    saveEmployees(employees);
    valid = true;
  }

  if (!valid) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

  const token = createEmployeeSession(emp.id);
  setEmployeeCookie(req, res, token);
  res.json({ ok: true, employee: { id: emp.id, name: emp.name, role: emp.role || "", phone: emp.phone || "" } });
});

app.post("/employee/logout", (req, res) => {
  clearEmployeeCookie(req, res);
  res.json({ ok: true });
});

app.get("/employee/api/company", (req,res)=>{ const emp=getEmployeeFromRequest(req); if(!emp)return res.status(401).json({error:"Session expirée"}); const c=getCompany(emp.companyId); if(!c)return res.status(404).json({error:"COMPANY_NOT_FOUND"}); res.json({id:c.id,name:c.name,logo:c.logo||"/logo.jpg",phone:c.phone||"",email:c.email||"",address:c.address||""}); });

app.get("/employee/api/me", (req, res) => {
  const emp = getEmployeeFromRequest(req);
  if (!emp) return res.status(401).json({ error: "Session expirée" });
  const employeeName = emp.name;
  const mine = appointments.filter(a => String(a.companyId || "company_default") === String(emp.companyId || "company_default") && (String(a.employeeId || "") === String(emp.id) || String(a.employee || "") === employeeName));
  res.json({ employee: { id: emp.id, name: emp.name, role: emp.role || "", phone: emp.phone || "" }, appointments: mine });
});

app.patch("/employee/api/appointments/:id", (req, res) => {
  const emp = getEmployeeFromRequest(req);
  if (!emp) return res.status(401).json({ error: "Session expirée" });
  const id = Number(req.params.id);
  const appt = appointments.find(a => Number(a.id) === id && String(a.companyId || "company_default") === String(emp.companyId || "company_default"));
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const mine = String(appt.employeeId || "") === String(emp.id) || String(appt.employee || "") === emp.name;
  if (!mine) return res.status(403).json({ error: "هاد السيارة ماشي مسندة ليك" });
  const allowed = ["En attente", "En cours", "Terminé"];
  const oldStatus = appt.status;
  if (req.body.status !== undefined) {
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Statut غير صالح" });
    appt.status = req.body.status;
  }
  saveAppointments(appointments);
  res.json(appt);

  // توصل تلقائي للزبون (نفس المنطق ديال admin) ملي العامل يبدل الحالة
  notifyCustomerStatusChange(appt, oldStatus);
});

app.get("/login", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MR GARAGE — Connexion</title>
  <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b0d;font-family:Arial,sans-serif}.box{background:#121518;border:1px solid #292e33;border-radius:14px;padding:28px;width:min(360px,90%)}h1{color:#fff;font-size:20px;margin:0 0 18px}input{width:100%;box-sizing:border-box;background:#0b0e10;border:1px solid #30363b;color:#fff;border-radius:8px;padding:12px;margin-bottom:12px;outline:none}button{width:100%;background:#ef2029;border:0;color:#fff;padding:13px;border-radius:8px;font-weight:700}.err{color:#ff6b6b;font-size:13px;margin-bottom:10px}</style></head><body>
  <form class="box" method="POST" action="/login"><img src="/mr-garage-logo.png" style="width:56px;height:56px;object-fit:contain;display:block;margin:0 auto 10px"><h1 style="text-align:center">🔒 MR GARAGE</h1>${req.query.err ? '<div class="err">Identifiants invalides ou compte désactivé</div>' : ""}<input name="username" placeholder="Nom d'utilisateur" autocomplete="username" required><input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" required><button type="submit">Se connecter</button></form></body></html>`);
});
app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const company = companies.find(c => String(c.username || "").trim().toLowerCase() === username);
  if (!company || company.active === false || !verifyPassword(password, company)) return res.redirect("/login?err=1");
  setAuthCookie(req, res, { role: "company", companyId: company.id, exp: Date.now() + 2592000000 });
  res.redirect("/dashboard");
});

app.get("/admin/login", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MR GARAGE — Super Admin</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b0d;color:#fff;font-family:Arial}.box{width:min(380px,90%);background:#121518;border:1px solid #292e33;border-radius:14px;padding:28px}input{width:100%;box-sizing:border-box;margin:8px 0 14px;padding:12px;background:#0b0e10;color:#fff;border:1px solid #30363b;border-radius:8px}button{width:100%;padding:13px;background:#ef2029;color:#fff;border:0;border-radius:8px;font-weight:bold}.err{color:#ff6b6b;font-size:13px}</style></head><body><form class="box" method="POST" action="/admin/login"><img src="/mr-garage-logo.png" style="width:56px;height:56px;object-fit:contain;display:block;margin:0 auto 10px"><h1 style="text-align:center">MR GARAGE</h1>${req.query.err?'<div class="err">Mot de passe incorrect</div>':''}<input type="password" name="password" placeholder="Mot de passe Admin" required><button>Entrer</button></form></body></html>`);
});
app.post("/admin/login", express.urlencoded({ extended: true }), (req, res) => {
  if (String(req.body.password || "") !== DASHBOARD_PASSWORD) return res.redirect("/admin/login?err=1");
  setAuthCookie(req, res, { role: "superadmin", exp: Date.now() + 2592000000 });
  res.redirect("/admin");
});
app.use((req, res, next) => {
  if (["/login", "/admin/login"].includes(req.path) || req.path === "/employee" || req.path === "/employee/login" || req.path === "/employee/logout") return next();
  const auth = getAuth(req);
  if (req.path.startsWith("/admin")) {
    if (auth?.role === "superadmin") return next();
    return req.path.startsWith("/api/") ? res.status(401).json({ error: "ADMIN_AUTH_REQUIRED" }) : res.redirect("/admin/login");
  }
  if (auth?.role === "company" && getCompany(auth.companyId)?.active !== false) { req.company = getCompany(auth.companyId); return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "COMPANY_AUTH_REQUIRED" });
  return res.redirect("/login");
});
app.get("/logout", (req, res) => { res.setHeader("Set-Cookie", "auth=; HttpOnly; Path=/; Max-Age=0"); res.redirect("/login"); });

const logoUpload = multer({
  storage: multer.diskStorage({ destination:(req,file,cb)=>cb(null,UPLOADS_DIR), filename:(req,file,cb)=>cb(null,`company-${req.params.id}-${Date.now()}${path.extname(file.originalname)||".jpg"}`) }),
  limits:{fileSize:4*1024*1024}, fileFilter:(req,file,cb)=>cb(null,/^image\//.test(file.mimetype))
});

app.get("/admin/api/companies", requireAdmin, (req, res) => {
  res.json(companies.map(c => ({ id:c.id, name:c.name, slug:c.slug, logo:c.logo||"", phone:c.phone||"", email:c.email||"", address:c.address||"", country:c.country||"MA", currency:c.currency||"MAD", username:c.username||"", active:c.active!==false, createdAt:c.createdAt, employees:scoped(employees,c.id).length, appointments:scoped(appointments,c.id).length, hasBotToken:!!c.telegramBotToken, botRunning:!!runningBots[String(c.id)], telegramChatId:c.telegramChatId||"" })));
});
app.post("/admin/api/companies", requireAdmin, (req, res) => {
  const { name, username, password, phone, email, address, logo, country, currency, telegramBotToken } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({error:"NAME_USERNAME_PASSWORD_REQUIRED"});
  if (companies.some(c => String(c.username).toLowerCase() === String(username).trim().toLowerCase())) return res.status(409).json({error:"USERNAME_TAKEN"});
  let slug = slugify(name), n=2; while(companies.some(c=>c.slug===slug)) slug=slugify(name)+"-"+(n++);
  const {salt,hash}=hashPassword(password);
  const c={id:`company_${Date.now()}`,name:String(name).trim(),slug,logo:logo||"/mr-garage-logo.png",phone:phone||"",email:email||"",address:address||"",country:normalizeCountry(country||"MA"),currency:normalizeCurrency(currency||"MAD"),username:String(username).trim(),passwordSalt:salt,passwordHash:hash,active:true,telegramBotToken:telegramBotToken?String(telegramBotToken).trim():"",telegramChatId:"",createdAt:new Date().toISOString()};
  companies.push(c); saveJson(COMPANIES_FILE,companies);
  if (c.telegramBotToken) startCompanyBot(c);
  res.json({id:c.id,name:c.name,slug:c.slug,logo:c.logo,username:c.username,country:c.country,currency:c.currency,active:c.active,hasBotToken:!!c.telegramBotToken});
});
app.patch("/admin/api/companies/:id", requireAdmin, (req,res)=>{
  const c=getCompany(req.params.id); if(!c) return res.status(404).json({error:"COMPANY_NOT_FOUND"});
  const {name,username,password,phone,email,address,logo,country,currency,active,telegramBotToken}=req.body||{};
  if(username!==undefined && companies.some(x=>x.id!==c.id && String(x.username).toLowerCase()===String(username).trim().toLowerCase())) return res.status(409).json({error:"USERNAME_TAKEN"});
  if(name!==undefined)c.name=String(name).trim(); if(username!==undefined)c.username=String(username).trim(); if(phone!==undefined)c.phone=String(phone); if(email!==undefined)c.email=String(email); if(address!==undefined)c.address=String(address); if(country!==undefined)c.country=normalizeCountry(country); if(currency!==undefined)c.currency=normalizeCurrency(currency); if(logo!==undefined)c.logo=String(logo); if(active!==undefined)c.active=!!active;
  if(password){const {salt,hash}=hashPassword(password);c.passwordSalt=salt;c.passwordHash=hash;}
  const tokenChanged = telegramBotToken!==undefined && String(telegramBotToken).trim() !== (c.telegramBotToken||"");
  if(telegramBotToken!==undefined) c.telegramBotToken = String(telegramBotToken).trim();
  saveJson(COMPANIES_FILE,companies);
  if (tokenChanged || active!==undefined) {
    if (c.active!==false && c.telegramBotToken) startCompanyBot(c);
    else stopCompanyBot(c.id);
  }
  res.json({ok:true,company:{id:c.id,name:c.name,slug:c.slug,logo:c.logo,phone:c.phone,email:c.email,address:c.address,country:c.country,currency:c.currency,username:c.username,active:c.active,hasBotToken:!!c.telegramBotToken}});
});
app.post("/admin/api/companies/:id/logo", requireAdmin, logoUpload.single("logo"), (req,res)=>{
  const c=getCompany(req.params.id);
  if(!c)return res.status(404).json({error:"COMPANY_NOT_FOUND"});
  if(!req.file)return res.status(400).json({error:"LOGO_REQUIRED"});
  // مهم: استعمل نفس filename اللي عطاه multer، باش الرابط يطابق الملف الحقيقي.
  const oldLogo = c.logo;
  c.logo = `/uploads/${req.file.filename}`;
  saveJson(COMPANIES_FILE,companies);
  // نحاول نحيد اللوغو القديم إذا كان ملف محلي داخل uploads.
  if(oldLogo && oldLogo.startsWith('/uploads/')) {
    const oldPath = path.join(__dirname, 'public', oldLogo.replace(/^\//, ''));
    if(oldPath !== path.join(__dirname, 'public', c.logo.replace(/^\//, '')) && fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
  }
  res.json({ok:true,logo:c.logo});
});
app.post("/admin/api/companies/:id/toggle", requireAdmin, (req,res)=>{const c=getCompany(req.params.id);if(!c)return res.status(404).json({error:"COMPANY_NOT_FOUND"});c.active=c.active===false;saveJson(COMPANIES_FILE,companies);if(c.active && c.telegramBotToken) startCompanyBot(c); else stopCompanyBot(c.id); res.json({ok:true,active:c.active});});
app.delete("/admin/api/companies/:id", requireAdmin, (req,res)=>{const c=getCompany(req.params.id);if(!c)return res.status(404).json({error:"COMPANY_NOT_FOUND"});if(c.id===companies[0].id)return res.status(400).json({error:"DEFAULT_COMPANY_PROTECTED"});stopCompanyBot(c.id);companies=companies.filter(x=>x.id!==c.id);saveJson(COMPANIES_FILE,companies);res.json({ok:true});});

app.get("/admin", requireAdmin, (req,res) => res.sendFile(path.join(__dirname,"public","admin.html")));


app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.use("/api", requireCompany);

app.get("/api/company/employee-link", (req, res) => {
  const c = req.company;
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/employee?garage=${encodeURIComponent(c.username || c.slug || c.id)}` });
});

app.get("/api/company", (req, res) => {
  const c = req.company;
  res.json({ id: c.id, name: c.name, logo: c.logo || "/mr-garage-logo.png", phone: c.phone || "", email: c.email || "", address: c.address || "", country: c.country || "MA", currency: c.currency || "MAD", username: c.username || "" });
});

// ---------- تغيير كلمة سر صاحب الكاراج ----------
// صاحب الكاراج يقدر يبدل كلمة السر فقط؛ اسم المستخدم كيبقى تحت تحكم Super Admin.
app.post("/api/company/password", (req, res) => {
  const c = req.company;
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "PASSWORD_REQUIRED" });
  if (newPassword.length < 6) return res.status(400).json({ error: "PASSWORD_TOO_SHORT" });
  if (!verifyPassword(currentPassword, c)) return res.status(401).json({ error: "CURRENT_PASSWORD_INVALID" });
  const { salt, hash } = hashPassword(newPassword);
  c.passwordSalt = salt;
  c.passwordHash = hash;
  saveJson(COMPANIES_FILE, companies);
  res.json({ ok: true });
});
app.get("/api/appointments", (req, res) => { res.json(scoped(appointments, req.company.id)); });

app.post("/api/appointments", (req, res) => {
  const { name, car, service, time, status, date, issue, employee, employeeId, phone } = req.body;
  if (!name || !car || !time) {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والوقت" });
  }
  const appt = {
    companyId: req.company.id,
    id: Date.now(),
    code: generateUniqueCode(),
    date: date || toISODate(new Date()),
    time,
    name,
    phone: phone || "",
    car,
    issue: issue || "-",
    service: service || "Autre",
    status: status || "En attente",
    employee: employee || "",
    employeeId: employeeId ? Number(employeeId) : null,
    source: "Dashboard",
    photosBefore: [],
    photosAfter: [],
    parts: [],
    reminderSent: false,
  };
  appointments.push(appt);
  saveAppointments(appointments);
  notifyOwnerNewAppointment(appt);
  res.json(appt);
});

app.patch("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  const appt = appointments.find((a) => a.id === id && String(a.companyId || "company_default") === String(req.company.id));
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const oldStatus = appt.status;
  if (req.body.employee !== undefined) appt.employee = req.body.employee;
  if (req.body.employeeId !== undefined) appt.employeeId = req.body.employeeId ? Number(req.body.employeeId) : null;
  if (req.body.status !== undefined) appt.status = req.body.status;
  saveAppointments(appointments);
  res.json(appt);

  // ---- توصل تلقائي للزبون ملي الحالة كتبدل (En cours / Terminé / Annulé) ----
  // إلا الزبون حجز عبر تيليغرام (عندو chatId) كنصيفطو ليه رسالة فالبوت — مجاني ومباشر.
  // إلا حجز عبر الداشبورد وماعندوش chatId، كنستعملو WhatsApp/SMS (Twilio) كـ fallback.
  notifyCustomerStatusChange(appt, oldStatus);

  // ---- إلا الموعد تلغى، نشوفو واش كاين حد فلائحة الانتظار لنفس اليوم ونعلموه ----
  if (appt.status === "Annulé" && oldStatus !== "Annulé") {
    const candidate = waitlist.find((w) => String(w.companyId || "company_default") === String(req.company.id) && !w.notified && (!w.preferredDate || w.preferredDate === appt.date));
    if (candidate) {
      candidate.notified = true;
      saveWaitlist(waitlist);
      if (candidate.chatId) {
        bot
          .sendMessage(
            candidate.chatId,
            `🎉 حرر وقت! يمكن ليك تحجز موعد فـ ${appt.date} — ${appt.time}. صيفط /rdv باش تحجز بسرعة.`
          )
          .catch(() => {});
      }
      notifyOwner(`ℹ️ حرر وقت بعد إلغاء موعد — كاين زبون فلائحة الانتظار (${candidate.name}) تعلم.`, req.company.id);
    }
  }
});

app.delete("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  appointments = appointments.filter((a) => !(a.id === id && String(a.companyId || "company_default") === String(req.company.id)));
  saveAppointments(appointments);
  res.json({ ok: true });
});

// ---------- API العمال ----------
app.get("/api/employees", (req, res) => {
  res.json(scoped(employees, req.company.id).map(e => ({ id: e.id, name: e.name, role: e.role || "", phone: e.phone || "", login: e.login || "", hasPassword: !!e.passwordHash })));
});

app.post("/api/employees", (req, res) => {
  const { name, role, phone, login, password } = req.body || {};
  if (!name || !login || !password) return res.status(400).json({ error: "MISSING_FIELDS" });
  if (scoped(employees, req.company.id).some(e => String(e.login || "").toLowerCase() === String(login).trim().toLowerCase())) {
    return res.status(409).json({ error: "LOGIN_TAKEN" });
  }
  const { salt, hash } = hashEmployeePassword(password);
  const emp = { companyId: req.company.id, id: Date.now(), name: name.trim(), role: role || "", phone: phone || "", login: login.trim(), passwordSalt: salt, passwordHash: hash };
  employees.push(emp);
  saveEmployees(employees);
  res.json({ id: emp.id, name: emp.name, role: emp.role, phone: emp.phone, login: emp.login, hasPassword: true });
});

app.patch("/api/employees/:id", (req, res) => {
  const id = Number(req.params.id);
  const emp = employees.find(e => Number(e.id) === id && String(e.companyId || "company_default") === String(req.company.id));
  if (!emp) return res.status(404).json({ error: "العامل ماكاينش" });
  const { name, role, phone, password } = req.body || {};
  if (name !== undefined) emp.name = String(name).trim();
  if (role !== undefined) emp.role = role;
  if (phone !== undefined) emp.phone = phone;
  if (password) {
    const { salt, hash } = hashEmployeePassword(password);
    emp.passwordSalt = salt; emp.passwordHash = hash; delete emp.password;
  }
  saveEmployees(employees);
  res.json({ id: emp.id, name: emp.name, role: emp.role, phone: emp.phone, login: emp.login, hasPassword: !!emp.passwordHash });
});

app.delete("/api/employees/:id", (req, res) => {
  const id = Number(req.params.id);
  employees = employees.filter((e) => !(Number(e.id) === id && String(e.companyId || "company_default") === String(req.company.id)));
  appointments.forEach(a => { if (String(a.companyId || "company_default") === String(req.company.id) && Number(a.employeeId) === id) { a.employeeId = null; a.employee = ""; } });
  saveEmployees(employees);
  saveAppointments(appointments);
  res.json({ ok: true });
});

// ---------- API صور السيارة/الإصلاح (قبل / بعد) ----------
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `appt${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post("/api/appointments/:id/photos", photoUpload.single("photo"), (req, res) => {
  const id = Number(req.params.id);
  const appt = appointments.find((a) => a.id === id && String(a.companyId || "company_default") === String(req.company.id));
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  if (!req.file) return res.status(400).json({ error: "خاصك تصيفط صورة" });
  const type = req.body.type === "after" ? "after" : "before";
  const url = `/uploads/${req.file.filename}`;
  if (!appt.photosBefore) appt.photosBefore = [];
  if (!appt.photosAfter) appt.photosAfter = [];
  if (type === "after") appt.photosAfter.push(url);
  else appt.photosBefore.push(url);
  saveAppointments(appointments);
  res.json(appt);
});

app.delete("/api/appointments/:id/photos", (req, res) => {
  const id = Number(req.params.id);
  const appt = appointments.find((a) => a.id === id && String(a.companyId || "company_default") === String(req.company.id));
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const { type, url } = req.body;
  const key = type === "after" ? "photosAfter" : "photosBefore";
  appt[key] = (appt[key] || []).filter((u) => u !== url);
  const filePath = path.join(__dirname, "public", url.replace(/^\//, ""));
  fs.existsSync(filePath) && fs.unlink(filePath, () => {});
  saveAppointments(appointments);
  res.json(appt);
});

// ---------- API قطع الغيار المستعملة فكل موعد (مربوطة بالمخزون) ----------
app.post("/api/appointments/:id/parts", (req, res) => {
  const id = Number(req.params.id);
  const appt = appointments.find((a) => a.id === id && String(a.companyId || "company_default") === String(req.company.id));
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const { name, qty } = req.body;
  if (!name) return res.status(400).json({ error: "خاصك تعمر اسم القطعة" });
  const quantity = Number(qty) || 1;
  if (!appt.parts) appt.parts = [];
  appt.parts.push({ name, qty: quantity });
  // إلا كانت القطعة كاينة فالمخزون، ننقصو منو
  const item = inventory.find((i) => String(i.companyId || "company_default") === String(req.company.id) && i.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (item) {
    item.qty = Math.max(0, (Number(item.qty) || 0) - quantity);
    saveInventory(inventory);
  }
  saveAppointments(appointments);
  res.json(appt);
});

app.delete("/api/appointments/:id/parts/:index", (req, res) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.index);
  const appt = appointments.find((a) => a.id === id && String(a.companyId || "company_default") === String(req.company.id));
  if (!appt || !appt.parts || !appt.parts[idx]) return res.status(404).json({ error: "غير موجود" });
  appt.parts.splice(idx, 1);
  saveAppointments(appointments);
  res.json(appt);
});

// ---------- API المخزون (قطع الغيار) ----------
app.get("/api/inventory", (req, res) => {
  res.json(scoped(inventory, req.company.id));
});

app.post("/api/inventory", (req, res) => {
  const { name, qty, unit } = req.body;
  if (!name) return res.status(400).json({ error: "خاصك تعمر اسم القطعة" });
  const item = { companyId: req.company.id, id: Date.now(), name, qty: Number(qty) || 0, unit: unit || "unité(s)" };
  inventory.push(item);
  saveInventory(inventory);
  res.json(item);
});

app.patch("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  const item = inventory.find((i) => i.id === id && String(i.companyId || "company_default") === String(req.company.id));
  if (!item) return res.status(404).json({ error: "غير موجود" });
  if (req.body.qty !== undefined) item.qty = Number(req.body.qty) || 0;
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.unit !== undefined) item.unit = req.body.unit;
  saveInventory(inventory);
  res.json(item);
});

app.delete("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  inventory = inventory.filter((i) => !(i.id === id && String(i.companyId || "company_default") === String(req.company.id)));
  saveInventory(inventory);
  res.json({ ok: true });
});

// ---------- API لائحة الانتظار (waitlist) ----------
app.get("/api/waitlist", (req, res) => {
  res.json(scoped(waitlist, req.company.id));
});

app.post("/api/waitlist", (req, res) => {
  const { name, phone, car, service, preferredDate, issue } = req.body;
  if (!name || !car) return res.status(400).json({ error: "خاصك تعمر الاسم والسيارة" });
  const entry = {
    companyId: req.company.id,
    id: Date.now(),
    name,
    phone: phone || "",
    car,
    service: service || "-",
    issue: issue || "-",
    preferredDate: preferredDate || "",
    createdAt: toISODate(new Date()),
    source: "Dashboard",
  };
  waitlist.push(entry);
  saveWaitlist(waitlist);
  res.json(entry);
});

app.delete("/api/waitlist/:id", (req, res) => {
  const id = Number(req.params.id);
  waitlist = waitlist.filter((w) => !(w.id === id && String(w.companyId || "company_default") === String(req.company.id)));
  saveWaitlist(waitlist);
  res.json({ ok: true });
});

// ---------- API الزبناء (مبني من المواعيد: كل المعلومات + التاريخ ديال كل زبون) ----------
app.get("/api/clients", (req, res) => {
  const map = new Map();
  scoped(appointments, req.company.id).forEach((a) => {
    const key = (a.phone && a.phone.trim()) || a.name;
    if (!map.has(key)) {
      map.set(key, { name: a.name, phone: a.phone || "", cars: new Set(), history: [] });
    }
    const c = map.get(key);
    if (a.name) c.name = a.name; // آخر اسم مسجل
    if (a.phone) c.phone = a.phone;
    if (a.car) c.cars.add(a.car);
    c.history.push({
      id: a.id,
      date: a.date,
      time: a.time,
      car: a.car,
      service: a.service,
      issue: a.issue,
      status: a.status,
      employee: a.employee || "",
      code: a.code || "",
    });
  });
  const clients = Array.from(map.values()).map((c) => {
    const history = c.history.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
    return {
      name: c.name,
      phone: c.phone,
      cars: Array.from(c.cars),
      lastVisit: history[0] ? history[0].date : "",
      history,
    };
  });
  clients.sort((a, b) => (a.lastVisit < b.lastVisit ? 1 : -1));
  res.json(clients);
});

// ---------- API الفواتير (صاحب الورشة كيحدد الثمن) ----------
app.get("/api/invoices", (req, res) => {
  res.json(scoped(invoices, req.company.id));
});

app.post("/api/invoices", (req, res) => {
  const { name, car, service, price, appointmentId, phone } = req.body;
  if (!name || !car || price === undefined || price === "") {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والثمن" });
  }
  const inv = {
    companyId: req.company.id,
    id: Date.now(),
    date: toISODate(new Date()),
    name,
    phone: phone || "",
    car,
    service: service || "-",
    price: Number(price),
    currency: req.company.currency || "MAD",
    appointmentId: appointmentId || null,
  };
  invoices.push(inv);
  saveInvoices(invoices);
  res.json(inv);

  // إلا الفاتورة مرتبطة بموعد Terminé ديجا، صيفطها مباشرة للزبون فتيليغرام
  if (inv.appointmentId) {
    const linkedAppt = appointments.find((a) => Number(a.id) === Number(inv.appointmentId) && String(a.companyId || "company_default") === String(req.company.id));
    if (linkedAppt && linkedAppt.status === "Terminé") {
      sendInvoiceToCustomer(inv, linkedAppt);
    }
  }
});

app.delete("/api/invoices/:id", (req, res) => {
  const id = Number(req.params.id);
  invoices = invoices.filter((i) => !(i.id === id && String(i.companyId || "company_default") === String(req.company.id)));
  saveInvoices(invoices);
  res.json({ ok: true });
});

app.get("/api/invoices/:id/pdf", (req, res) => {
  const id = Number(req.params.id);
  const inv = invoices.find((i) => i.id === id && String(i.companyId || "company_default") === String(req.company.id));
  const lang = pdfLang(req);
  if (!inv) return res.status(404).send(pt(lang, "not_found_invoice"));
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=facture-${inv.id}.pdf`);
  doc.pipe(res);
  addPdfHeader(doc, pt(lang, "invoice"), req.company);
  doc.fontSize(11).fillColor("#000");
  doc.text(`${pt(lang, "invoice_no")} : ${inv.id}`);
  doc.text(`${pt(lang, "date")} : ${inv.date}`);
  doc.moveDown();
  doc.text(`${pt(lang, "client")} : ${inv.name}`);
  if (inv.phone) doc.text(`${pt(lang, "phone")} : ${inv.phone}`);
  doc.text(`${pt(lang, "vehicle")} : ${inv.car}`);
  doc.text(`${pt(lang, "service")} : ${pdfServiceLabel(lang, inv.service)}`);
  doc.moveDown();
  doc.fontSize(16).text(`${pt(lang, "total")} : ${inv.price} ${inv.currency || company.currency || "MAD"}`, { align: "right" });
  doc.end();
});

// ---------- بناء PDF ديال الفاتورة فـ buffer (باش تصيفط مباشرة فتيليغرام) ----------
function buildInvoicePdfBuffer(inv, lang, company = companies[0]) {
  lang = PDF_I18N[lang] ? lang : "fr";
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require("pdfkit");
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      addPdfHeader(doc, pt(lang, "invoice"), company);
      doc.fontSize(11).fillColor("#000");
      doc.text(`${pt(lang, "invoice_no")} : ${inv.id}`);
      doc.text(`${pt(lang, "date")} : ${inv.date}`);
      doc.moveDown();
      doc.text(`${pt(lang, "client")} : ${inv.name}`);
      if (inv.phone) doc.text(`${pt(lang, "phone")} : ${inv.phone}`);
      doc.text(`${pt(lang, "vehicle")} : ${inv.car}`);
      doc.text(`${pt(lang, "service")} : ${pdfServiceLabel(lang, inv.service)}`);
      doc.moveDown();
      doc.fontSize(16).text(`${pt(lang, "total")} : ${inv.price} ${inv.currency || company.currency || "MAD"}`, { align: "right" });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ---------- توصيل الفاتورة PDF مباشرة للزبون فتيليغرام (ملي الموعد Terminé) ----------
async function sendInvoiceToCustomer(inv, appt) {
  if (!appt || !appt.chatId) return;
  const entry = runningBots[String(appt.companyId)];
  if (!entry) return;
  try {
    const lang = getBotLang(appt.companyId, appt.chatId) || "fr";
    const buffer = await buildInvoicePdfBuffer(inv, lang, companyOf(appt.companyId));
    await entry.bot.sendDocument(
      appt.chatId,
      buffer,
      { caption: bt(appt.companyId, appt.chatId, "invoice_caption", { car: inv.car, price: inv.price, currency: inv.currency || companyOf(appt.companyId).currency || "MAD" }) },
      { filename: `facture-${inv.id}.pdf`, contentType: "application/pdf" }
    );
  } catch (e) {
    console.error("❌ ماقدرش يصيفط الفاتورة PDF للزبون فتيليغرام:", e.message);
  }
}

// ---------- en-tête مشترك للـ PDF (اللوغو + السمية) ----------
const LOGO_PATH = path.join(__dirname, "public", "logo.jpg");
function addPdfHeader(doc, subtitle, company = companies[0]) {
  const hasLogo = (() => { const lp = company?.logo && !company.logo.startsWith("data:") ? path.join(__dirname, "public", company.logo.replace(/^\//, "")) : LOGO_PATH; return fs.existsSync(lp); })();
  if (hasLogo) {
    const logoPath = company?.logo && !company.logo.startsWith("data:") ? path.join(__dirname, "public", company.logo.replace(/^\//, "")) : LOGO_PATH;
    if (fs.existsSync(logoPath)) doc.image(logoPath, 40, 35, { width: 55, height: 55 });
  }
  doc
    .fontSize(18)
    .fillColor("#000")
    .text(company?.name || "Garage", hasLogo ? 105 : 40, 45);
  doc
    .fontSize(10)
    .fillColor("#555")
    .text(subtitle, hasLogo ? 105 : 40, 68);
  doc.moveTo(40, 100).lineTo(555, 100).strokeColor("#ccc").stroke();
  doc.y = 115;
}

// ---------- تصدير PDF (جدول: الاسم، السيارة، المشكل...) ----------
app.get("/api/appointments/pdf", (req, res) => {
  const lang = pdfLang(req);
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=shahd-automotive-rendezvous.pdf");
  doc.pipe(res);

  addPdfHeader(doc, `${pt(lang, "appt_list_title")} ${new Date().toLocaleString(pt(lang, "locale"))}`, req.company);

  // ---- جدول ----
  const cols = [
    { label: pt(lang, "client"), width: 75 },
    { label: pt(lang, "vehicle"), width: 80 },
    { label: pt(lang, "problem"), width: 110 },
    { label: pt(lang, "date_time"), width: 75 },
    { label: pt(lang, "employee"), width: 85 },
    { label: pt(lang, "status"), width: 90 },
  ];
  let x = 40;
  let y = doc.y;
  const rowH = 22;

  function drawRow(values, opts = {}) {
    let cx = 40;
    if (opts.header) doc.rect(40, y, 515, rowH).fill("#eee").fillColor("#000");
    else if (opts.stripe) doc.rect(40, y, 515, rowH).fill("#f7f7f7").fillColor("#000");
    doc.fillColor("#000").fontSize(9);
    values.forEach((v, i) => {
      doc.text(String(v), cx + 4, y + 6, { width: cols[i].width - 8, ellipsis: true });
      cx += cols[i].width;
    });
    y += rowH;
    if (y > 780) {
      doc.addPage();
      y = 40;
    }
  }

  drawRow(cols.map((c) => c.label), { header: true });
  scoped(appointments, req.company.id).forEach((a, i) => {
    drawRow(
      [a.name, a.car, a.issue || "-", `${a.date} ${a.time}`, a.employee || "-", pdfStatus(lang, a.status)],
      { stripe: i % 2 === 1 }
    );
  });

  if (appointments.length === 0) {
    doc.fontSize(11).fillColor("#666").text(pt(lang, "no_appt"), 40, y + 10);
  }

  doc.end();
});

// ---------- تصدير PDF ديال موعد واحد بوحدو (بون دو ترافاي — فيه اسم العامل) ----------
app.get("/api/appointments/:id/pdf", (req, res) => {
  const id = Number(req.params.id);
  const a = appointments.find((x) => x.id === id && String(x.companyId || "company_default") === String(req.company.id));
  const lang = pdfLang(req);
  if (!a) return res.status(404).send(pt(lang, "not_found_appt"));

  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=fiche-vehicule-${a.id}.pdf`);
  doc.pipe(res);

  addPdfHeader(doc, pt(lang, "work_order"), req.company);

  doc.fontSize(11).fillColor("#000");
  if (a.code) doc.text(`${pt(lang, "tracking_code")} : ${a.code}`);
  doc.text(`${pt(lang, "date")} : ${a.date}    ${pt(lang, "hour")} : ${a.time}`);
  doc.moveDown();

  doc.fontSize(13).text(pt(lang, "client_section"));
  doc.fontSize(11).fillColor("#333");
  doc.text(`${pt(lang, "name")} : ${a.name}`);
  if (a.phone) doc.text(`${pt(lang, "phone")} : ${a.phone}`);
  doc.moveDown();

  doc.fillColor("#000").fontSize(13).text(pt(lang, "vehicle_section"));
  doc.fontSize(11).fillColor("#333");
  doc.text(`${pt(lang, "vehicle")} : ${a.car}`);
  doc.text(`${pt(lang, "reported_problem")} : ${a.issue || "-"}`);
  doc.moveDown();

  doc.fillColor("#000").fontSize(13).text(pt(lang, "intervention_section"));
  doc.fontSize(11).fillColor("#333");
  doc.text(`${pt(lang, "service")} : ${pdfServiceLabel(lang, a.service)}`);
  doc.text(`${pt(lang, "assigned_employee")} : ${a.employee || pt(lang, "unassigned")}`);
  doc.text(`${pt(lang, "status")} : ${pdfStatus(lang, a.status)}`);

  doc.moveDown(2);
  doc.fontSize(9).fillColor("#888").text(`${pt(lang, "generated_on")} ${new Date().toLocaleString(pt(lang, "locale"))}`);

  doc.end();
});

// ---------- تذكير أوتوماتيك يوم قبل الموعد (عبر تيليغرام، أو WhatsApp/SMS إلا كان الهاتف) ----------
function checkReminders() {
  appointments.forEach((appt) => {
    const tomorrow = dateLabel(1, appt.companyId).iso;
    if (appt.date !== tomorrow) return;
    if (appt.status === "Annulé" || appt.status === "Terminé") return;
    if (appt.reminderSent) return;
    const entry = runningBots[String(appt.companyId)];
    if (appt.chatId && entry) {
      const msg = bt(appt.companyId, appt.chatId, "reminder", { date: appt.date, time: appt.time, car: appt.car, service: botServiceLabel(appt.companyId, appt.chatId, appt.service) });
      entry.bot.sendMessage(appt.chatId, msg).catch(() => {});
    } else if (appt.phone) {
      const msg = `⏰ Rappel : rendez-vous demain (${appt.date} — ${appt.time}) chez ${companyOf(appt.companyId).name}\n🚗 ${appt.car}\n🔧 ${appt.service}`;
      sendWhatsAppOrSMS(appt.phone, msg);
    }
    appt.reminderSent = true;
  });
  saveAppointments(appointments);
}
setTimeout(checkReminders, 10000); // فحص عند الإقلاع
setInterval(checkReminders, 30 * 60 * 1000); // فحص كل 30 دقيقة

// ---------- تشغيل بوت كل ورشة عندها توكن مسجل، بعد ما السيرفر يبدا ----------
companies.filter((c) => c.active !== false && c.telegramBotToken).forEach(startCompanyBot);

app.listen(PORT, () => {
  console.log(`✅ السيرفر خدام على http://localhost:${PORT}`);
  console.log(`ℹ️ عدد الورشات المسجلة: ${companies.length} — بوتات خدامين: ${Object.keys(runningBots).length}`);
});
