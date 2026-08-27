// ===== SHAHD AUTOMOTIVE — Serveur (Telegram Bot + API + Dashboard) =====
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const multer = require("multer");
const crypto = require("crypto");

// ---------- الإعدادات ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // خاصك تعطيه القيمة (شوف README)
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "shahd2026"; // بدلها فـ Environment Variables
const DATA_FILE = path.join(__dirname, "appointments.json");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const EMPLOYEES_FILE = path.join(DATA_DIR, "employees.json");

// ---------- إعدادات جداد: تنبيه صاحب الورشة + SMS/WhatsApp ديال الزبون ----------
// OWNER_CHAT_ID : الـ chat id ديال صاحب الورشة/العامل فتيليغرام (باش يوصلو تنبيهات المواعيد الجداد)
// باش تعرف الـ chat id ديالك: صيفط أي رسالة للبوت من الحساب ديالك، وشوف اللوغ ديال السيرفر (كنطبعوه تحت).
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "";

// Twilio (اختياري) : باش تصيفط SMS/WhatsApp تلقائي للزبون. إلا ماكانوش هاد المتغيرات، غادي نخدمو بلا هاد الخاصية (بلا ما يطيح السيرفر).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ""; // مثال: whatsapp:+14155238886
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM || ""; // مثال: +1415XXXXXXX

const WAITLIST_FILE = path.join(__dirname, "waitlist.json");
const INVENTORY_FILE = path.join(__dirname, "inventory.json");
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");


if (!TOKEN) {
  console.error("❌ خاصك تدير TELEGRAM_BOT_TOKEN. شوف ملف README.md");
  process.exit(1);
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

// Optional first-run bootstrap for Railway. Set these environment variables once
// if the deployment starts without an employees.json file.
function bootstrapEmployeeFromEnv() {
  const login = String(process.env.EMPLOYEE_LOGIN || "").trim();
  const password = String(process.env.EMPLOYEE_PASSWORD || "");
  if (!login || !password) return;
  const normalized = login.toLowerCase();
  const existing = employees.find(e => String(e.login || e.username || e.user || "").trim().toLowerCase() === normalized);
  if (existing) return;
  const { salt, hash } = hashEmployeePassword(password);
  employees.push({
    id: Date.now(),
    name: String(process.env.EMPLOYEE_NAME || "Employé").trim(),
    role: String(process.env.EMPLOYEE_ROLE || "").trim(),
    phone: String(process.env.EMPLOYEE_PHONE || "").trim(),
    login,
    passwordSalt: salt,
    passwordHash: hash,
    active: true
  });
  saveEmployees(employees);
  console.log(`✅ Compte employé bootstrap créé: ${login}`);
}

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
bootstrapEmployeeFromEnv();

function createEmployeeSession(employeeId) {
  return signEmployeeSession({ employeeId: Number(employeeId), exp: Date.now() + 86400000 });
}
function getEmployeeFromRequest(req) {
  const cookies = parseCookies(req);
  const payload = verifyEmployeeSession(cookies.employee_session || "");
  if (!payload) return null;
  return employees.find(e => Number(e.id) === Number(payload.employeeId)) || null;
}
function setEmployeeCookie(req, res, token) {
  // Railway كيدوز HTTPS عبر proxy؛ كنستعمل Secure غير ملي الطلب فعلاً HTTPS.
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secure = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `employee_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400; Priority=High${secure}`);
}
function clearEmployeeCookie(req, res) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secure = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `employee_session=; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=0; Priority=High${secure}`);
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
function dateLabel(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const iso = toISODate(d);
  const labels = ["اليوم", "غدا", "بعد غد"];
  const label = labels[offsetDays] || d.toLocaleDateString("fr-FR");
  return { iso, label: `${label} (${d.toLocaleDateString("fr-FR")})` };
}
function prochainesDates() {
  return [dateLabel(0), dateLabel(1), dateLabel(2)];
}
function slotsDisponibles(date) {
  const prisPar = new Set(
    appointments.filter((a) => a.date === date).map((a) => a.time)
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

// ---------- البوت (polling، بلا حاجة لسيرفر HTTPS خارجي) ----------
const bot = new TelegramBot(TOKEN, { polling: true });

// باش تعرف الـ chat id ديال صاحب الورشة: كتبان فاللوغ ملي يصيفط أي حد رسالة للبوت
bot.on("message", (msg) => {
  if (!OWNER_CHAT_ID) {
    console.log(`ℹ️ Chat ID: ${msg.chat.id} (${msg.from?.first_name || ""}) — دير هادشي فـ OWNER_CHAT_ID إلا بغيتيه يوصلو التنبيهات`);
  }
});

// ---------- تنبيه صاحب الورشة/العامل فتيليغرام ملي يجي موعد جديد ----------
function notifyOwner(text) {
  if (!OWNER_CHAT_ID) return;
  bot.sendMessage(OWNER_CHAT_ID, text, { parse_mode: "Markdown" }).catch((e) => {
    console.error("❌ ماقدرش يصيفط التنبيه لصاحب الورشة:", e.message);
  });
}
function notifyOwnerNewAppointment(appt) {
  notifyOwner(
    `🆕 *موعد جديد!*\n\n👤 ${appt.name}\n📞 ${appt.phone || "-"}\n🚗 ${appt.car}\n🔧 ${appt.service}\n📅 ${appt.date} — 🕐 ${appt.time}\n📝 ${appt.issue || "-"}\n\n🔑 كود: ${appt.code || "-"}\n📍 مصدر: ${appt.source || "-"}`
  );
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

// حالة كل محادثة (كيتخزن فالذاكرة)
const sessions = {}; // chatId -> { step, data, flow }

const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      ["📅 حجز موعد إصلاح"],
      ["🔍 التحقق من حالة السيارة قبل الشراء"],
      ["🔑 تتبع حالة السيارة برقم التتبع"],
    ],
    resize_keyboard: true,
  },
};

function reset(chatId) {
  sessions[chatId] = { step: "menu", data: {}, flow: null };
}

bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  reset(chatId);
  bot.sendMessage(
    chatId,
    "أهلا بيك ف *SHAHD AUTOMOTIVE* 🚗🔧\nشنو بغيتي؟",
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
});

bot.onText(/\/rdv|موعد/i, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: "name", data: {}, flow: "rdv" };
  bot.sendMessage(chatId, "باغي نحجز ليك موعد إصلاح. أول حاجة، شنو سميتك الكاملة؟", {
    reply_markup: { remove_keyboard: true },
  });
});

// ---------- التحقق من رقم الهاتف (سيبتا فقط أرقام، مسافات، + و -) ----------
function phoneValide(text) {
  const clean = text.replace(/[\s\-]/g, "");
  return /^\+?\d{9,14}$/.test(clean);
}

// ---------- رسالة حالة السيارة انطلاقا من رقم التتبع ----------
function messageHalaSayara(appt) {
  const enCours = appt.status === "En attente" || appt.status === "En cours";
  const terminee = appt.status === "Terminé";
  const annulee = appt.status === "Annulé";
  let etat = "🟡 مازالت فالانتظار";
  if (appt.status === "En cours") etat = "🔧 كتصلح دابا";
  if (terminee) etat = "✅ صلاحات — واجدة";
  if (annulee) etat = "❌ الموعد ملغي";

  let msg = `🔑 رقم التتبع: *${appt.code}*\n\n`;
  msg += `👤 ${appt.name}\n🚗 ${appt.car}\n📅 ${appt.date} — 🕐 ${appt.time}\n\n`;
  msg += `المشكل المصرح بيه: ${appt.issue || "-"}\n`;
  msg += `الخدمة/الإصلاح: ${appt.service}\n`;
  msg += `العامل المكلف: ${appt.employee || "غير محدد بعد"}\n\n`;
  msg += `الحالة: ${etat}`;
  if (terminee) msg += `\n\nالسيارة ديالك واجدة، تقدر تجي تاخدها 🎉`;
  return msg;
}

bot.onText(/\/track/i, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: "track_code", data: {}, flow: "track" };
  bot.sendMessage(chatId, "دخل رقم التتبع ديالك (6 أرقام):", {
    reply_markup: { remove_keyboard: true },
  });
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return; // الأوامر كيتقادو فوق

  if (!sessions[chatId]) {
    reset(chatId);
    bot.sendMessage(chatId, "أهلا! صيفط /start باش نبداو 🚗", MAIN_MENU);
    return;
  }

  const session = sessions[chatId];

  // ---- القائمة الرئيسية ----
  if (session.step === "menu") {
    if (/^\d{6}$/.test(text)) {
      // الزبون صيفط رقم التتبع مباشرة بلا ما يختار من القائمة
      const appt = appointments.find((a) => a.code === text);
      if (!appt) {
        bot.sendMessage(chatId, "ماكايناش موعد بهاد الرقم 🤔 تأكد منو أو تواصل مع SHAHD AUTOMOTIVE.", MAIN_MENU);
      } else {
        bot.sendMessage(chatId, messageHalaSayara(appt), { parse_mode: "Markdown", ...MAIN_MENU });
      }
      return;
    }
    if (text.includes("حجز") || (text.includes("موعد") && !text.includes("تتبع"))) {
      session.flow = "rdv";
      session.step = "name";
      bot.sendMessage(chatId, "أول حاجة، شنو سميتك الكاملة؟", { reply_markup: { remove_keyboard: true } });
    } else if (text.includes("التحقق") || text.includes("فحص") || text.includes("achat")) {
      session.flow = "verification";
      session.step = "name";
      bot.sendMessage(chatId, "خدمة التحقق من حالة السيارة قبل الشراء ✅\nشنو سميتك الكاملة؟", {
        reply_markup: { remove_keyboard: true },
      });
    } else if (text.includes("تتبع")) {
      session.flow = "track";
      session.step = "track_code";
      bot.sendMessage(chatId, "دخل رقم التتبع ديالك (6 أرقام):", {
        reply_markup: { remove_keyboard: true },
      });
    } else {
      bot.sendMessage(chatId, "من فضلك ختار من القائمة تحت 👇", MAIN_MENU);
    }
    return;
  }

  // ---- تتبع الحالة برقم التتبع ----
  if (session.step === "track_code") {
    const code = text.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      bot.sendMessage(chatId, "رقم التتبع خاصو يكون 6 أرقام بالضبط 🙏 عاود جرب:");
      return;
    }
    const appt = appointments.find((a) => a.code === code);
    if (!appt) {
      bot.sendMessage(
        chatId,
        "ماكايناش موعد بهاد الرقم 🤔 تأكد منو أو تواصل مع SHAHD AUTOMOTIVE.",
        MAIN_MENU
      );
      delete sessions[chatId];
      return;
    }
    bot.sendMessage(chatId, messageHalaSayara(appt), { parse_mode: "Markdown", ...MAIN_MENU });
    delete sessions[chatId];
    return;
  }

  switch (session.step) {
    case "name":
      session.data.name = text;
      session.step = "phone";
      bot.sendMessage(chatId, "شنو رقم الهاتف ديالك؟ (باش نقدرو نتواصلو معاك)");
      break;

    case "phone":
      if (!phoneValide(text)) {
        bot.sendMessage(chatId, "رقم الهاتف ماشي صحيح 🙏 من فضلك كتبو مزيان (مثلا: 0600000000)");
        return;
      }
      session.data.phone = text.trim();
      session.step = "car";
      bot.sendMessage(chatId, "شنو نوع السيارة؟ (مثلا: Toyota Corolla 2018)");
      break;

    case "car":
      session.data.car = text;
      if (session.flow === "verification") {
        session.step = "date";
        const dates = prochainesDates();
        session.data.dateOptions = dates;
        session.data.service = "Vérification état avant achat";
        session.data.issue = "-";
        bot.sendMessage(
          chatId,
          "فأي يوم بغيتي تجي للفحص؟\n" +
            dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") +
            "\n\nكتب رقم اليوم."
        );
      } else {
        session.step = "issue";
        bot.sendMessage(chatId, "شنو المشكل اللي كاين فالسيارة؟ (وصف قصير)");
      }
      break;

    case "issue":
      session.data.issue = text;
      session.step = "service";
      bot.sendMessage(
        chatId,
        "شنو الخدمة اللي بغيتي؟\n" +
          SERVICES.map((s, i) => `${i + 1}. ${s}`).join("\n") +
          "\n\nكتب رقم الخدمة."
      );
      break;

    case "service": {
      const idx = parseInt(text, 10) - 1;
      const service = SERVICES[idx];
      if (!service) {
        bot.sendMessage(chatId, "من فضلك كتب رقم صحيح من اللائحة (1-" + SERVICES.length + ")");
        return;
      }
      session.data.service = service;
      session.step = "date";
      const dates = prochainesDates();
      session.data.dateOptions = dates;
      bot.sendMessage(
        chatId,
        "فأي يوم بغيتي الموعد؟\n" +
          dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") +
          "\n\nكتب رقم اليوم."
      );
      break;
    }

    case "date": {
      const idx = parseInt(text, 10) - 1;
      const chosen = session.data.dateOptions[idx];
      if (!chosen) {
        bot.sendMessage(chatId, "من فضلك كتب رقم صحيح من اللائحة (1-" + session.data.dateOptions.length + ")");
        return;
      }
      session.data.date = chosen.iso;
      const dispo = slotsDisponibles(chosen.iso);
      if (dispo.length === 0) {
        session.step = "date_full";
        bot.sendMessage(
          chatId,
          `معذرة، ماكاين حتى وقت متاح ف${chosen.label} 🙏\n\nشنو بغيتي؟\n1. نختار يوم آخر\n2. نتسجل فلائحة الانتظار (نتصل بيك أول ما يحرر وقت)\n\nكتب رقم الاختيار.`
        );
        return;
      }
      session.step = "time";
      bot.sendMessage(
        chatId,
        "فأي وقت تفضل؟\n" + dispo.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n\nكتب رقم الوقت."
      );
      break;
    }

    // ---- اليوم مكمل: يختار يوم آخر أو يتسجل فلائحة الانتظار ----
    case "date_full": {
      if (text.trim() === "1") {
        session.step = "date";
        const dates = prochainesDates();
        session.data.dateOptions = dates;
        bot.sendMessage(
          chatId,
          "فأي يوم بغيتي الموعد؟\n" + dates.map((d, i) => `${i + 1}. ${d.label}`).join("\n") + "\n\nكتب رقم اليوم."
        );
      } else if (text.trim() === "2") {
        const entry = {
          id: Date.now(),
          name: session.data.name,
          phone: session.data.phone || "",
          car: session.data.car,
          issue: session.data.issue || "-",
          service: session.data.service,
          preferredDate: session.data.date,
          createdAt: toISODate(new Date()),
          source: "Telegram",
          chatId,
        };
        waitlist.push(entry);
        saveWaitlist(waitlist);
        notifyOwner(
          `⏳ *تسجيل جديد فلائحة الانتظار*\n\n👤 ${entry.name}\n📞 ${entry.phone || "-"}\n🚗 ${entry.car}\n🔧 ${entry.service}\n📅 اليوم المفضل: ${entry.preferredDate}`
        );
        bot.sendMessage(
          chatId,
          "✅ تم تسجيلك فلائحة الانتظار! غانتصلو بيك أول ما يحرر وقت مناسب 🙏",
          MAIN_MENU
        );
        delete sessions[chatId];
      } else {
        bot.sendMessage(chatId, "من فضلك كتب 1 أو 2 🙏");
      }
      break;
    }

    case "time": {
      const dispo = slotsDisponibles(session.data.date);
      const idx = parseInt(text, 10) - 1;
      const time = dispo[idx];
      if (!time) {
        bot.sendMessage(chatId, "من فضلك كتب رقم صحيح من اللائحة.");
        return;
      }
      const appt = {
        id: Date.now(),
        code: generateUniqueCode(),
        date: session.data.date,
        time,
        name: session.data.name,
        phone: session.data.phone || "",
        car: session.data.car,
        issue: session.data.issue || "-",
        service: session.data.service,
        status: "En attente",
        employee: "",
        source: "Telegram",
        chatId,
        photosBefore: [],
        photosAfter: [],
        parts: [],
        reminderSent: false,
      };
      appointments.push(appt);
      saveAppointments(appointments);
      notifyOwnerNewAppointment(appt);
      // رسالة التأكيد + زر "نسخ الرقم" باش الزبون يحفظ الكود بسهولة
      bot
        .sendMessage(
          chatId,
          `✅ تم تأكيد الموعد ديالك!\n\n👤 ${appt.name}\n📞 ${appt.phone}\n🚗 ${appt.car}\n🔧 ${appt.service}\n📅 ${appt.date}\n🕐 ${appt.time}\n\n🔑 رقم التتبع ديالك: *${appt.code}*\n(احتفظ بيه، غايتطلب منك من بعد)\n\nنتسناوك ف SHAHD AUTOMOTIVE!`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "📋 نسخ الرقم", copy_text: { text: appt.code } }]] },
          }
        )
        .then(() => {
          bot.sendMessage(chatId, "شنو بغيتي دابا؟ 👇", MAIN_MENU);
        });
      delete sessions[chatId];
      break;
    }
  }
});

// ---------- API باش الصفحة تقرا/تزيد المواعيد ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(__dirname, "employee.html"));
});

app.get("/employee/login", (req, res) => {
  res.redirect("/employee");
});

app.get("/employee/health", (req, res) => {
  res.json({ ok: true, employeeCount: employees.length, storage: DATA_DIR === path.join(__dirname, "data") ? "local" : "custom" });
});

app.post("/employee/login", (req, res) => {
  const login = String(req.body?.login || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!login || !password) return res.status(400).json({ error: "Login و Password مطلوبين" });

  const emp = employees.find(e => {
    const storedLogin = String(e.login ?? e.username ?? e.user ?? "").trim().toLowerCase();
    return storedLogin === login;
  });
  if (!emp) return res.status(401).json({ error: "Login أو Password غير صحيح" });

  if (emp.active === false || emp.disabled === true) return res.status(403).json({ error: "حساب العامل غير مفعل" });

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

  if (!valid) return res.status(401).json({ error: "Login أو Password غير صحيح" });

  const token = createEmployeeSession(emp.id);
  setEmployeeCookie(req, res, token);
  res.json({ ok: true, employee: { id: emp.id, name: emp.name, role: emp.role || "", phone: emp.phone || "" } });
});

app.post("/employee/logout", (req, res) => {
  clearEmployeeCookie(req, res);
  res.json({ ok: true });
});

app.get("/employee/api/me", (req, res) => {
  const emp = getEmployeeFromRequest(req);
  if (!emp) return res.status(401).json({ error: "Session expirée" });
  const employeeName = emp.name;
  const mine = appointments.filter(a => String(a.employeeId || "") === String(emp.id) || String(a.employee || "") === employeeName);
  res.json({ employee: { id: emp.id, name: emp.name, role: emp.role || "", phone: emp.phone || "" }, appointments: mine });
});

app.patch("/employee/api/appointments/:id", (req, res) => {
  const emp = getEmployeeFromRequest(req);
  if (!emp) return res.status(401).json({ error: "Session expirée" });
  const id = Number(req.params.id);
  const appt = appointments.find(a => Number(a.id) === id);
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const mine = String(appt.employeeId || "") === String(emp.id) || String(appt.employee || "") === emp.name;
  if (!mine) return res.status(403).json({ error: "هاد السيارة ماشي مسندة ليك" });
  const allowed = ["En attente", "En cours", "Terminé"];
  if (req.body.status !== undefined) {
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Statut غير صالح" });
    appt.status = req.body.status;
  }
  saveAppointments(appointments);
  res.json(appt);
});

app.get("/login", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion — SHAHD AUTOMOTIVE</title>
  <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b0d;font-family:Arial,sans-serif}.box{background:#121518;border:1px solid #292e33;border-radius:14px;padding:28px;width:min(340px,90%)}h1{color:#fff;font-size:20px;margin:0 0 18px}input{width:100%;box-sizing:border-box;background:#0b0e10;border:1px solid #30363b;color:#fff;border-radius:8px;padding:12px;margin-bottom:12px;outline:none}button{width:100%;background:#ef2029;border:0;color:#fff;padding:13px;border-radius:8px;font-weight:700}
  .err{color:#ff6b6b;font-size:13px;margin-bottom:10px}</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>🔒 SHAHD AUTOMOTIVE</h1>
    ${req.query.err ? '<div class="err">كلمة السر خاطئة</div>' : ""}
    <input type="password" name="password" placeholder="كلمة السر" autofocus required>
    <button type="submit">دخول</button>
  </form></body></html>`);
});

app.post("/login", express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.setHeader(
      "Set-Cookie",
      `auth=${encodeURIComponent(DASHBOARD_PASSWORD)}; HttpOnly; Path=/; Max-Age=2592000`
    );
    return res.redirect("/");
  }
  res.redirect("/login?err=1");
});

app.use((req, res, next) => {
  if (req.path === "/login") return next();
  const cookies = parseCookies(req);
  if (cookies.auth === DASHBOARD_PASSWORD) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "غير مسموح" });
  return res.redirect("/login");
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "auth=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/login");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/appointments", (req, res) => {
  res.json(appointments);
});

app.post("/api/appointments", (req, res) => {
  const { name, car, service, time, status, date, issue, employee, employeeId, phone } = req.body;
  if (!name || !car || !time) {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والوقت" });
  }
  const appt = {
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
  const appt = appointments.find((a) => a.id === id);
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
  const notifiableStatuses = ["En cours", "Terminé", "Annulé"];
  if (notifiableStatuses.includes(appt.status) && appt.status !== oldStatus) {
    const statusMsgs = {
      "En cours": `🔧 مرحبا ${appt.name}، بدينا فالخدمة ديال السيارة ديالك (${appt.car}) دابا.\n\n🔑 رقم التتبع: ${appt.code || "-"}`,
      Terminé: `✅ مرحبا ${appt.name}، السيارة ديالك (${appt.car}) صلاحات وواجدة! تقدر تجي تاخدها.\n\n🔑 رقم التتبع: ${appt.code || "-"}`,
      Annulé: `❌ مرحبا ${appt.name}، الموعد ديالك ديال ${appt.date} — ${appt.time} تلغى. تواصل معانا إلا بغيتي تعاود تحجز.`,
    };
    const text = statusMsgs[appt.status];
    if (appt.chatId) {
      bot.sendMessage(appt.chatId, text, { parse_mode: "Markdown" }).catch((e) => {
        console.error("❌ ماقدرش يصيفط توصل تيليغرام للزبون:", e.message);
      });
    } else if (appt.phone) {
      sendWhatsAppOrSMS(appt.phone, `SHAHD AUTOMOTIVE\n\n${text}`);
    }
  }

  // ---- إلا الموعد تلغى، نشوفو واش كاين حد فلائحة الانتظار لنفس اليوم ونعلموه ----
  if (appt.status === "Annulé" && oldStatus !== "Annulé") {
    const candidate = waitlist.find((w) => !w.notified && (!w.preferredDate || w.preferredDate === appt.date));
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
      notifyOwner(`ℹ️ حرر وقت بعد إلغاء موعد — كاين زبون فلائحة الانتظار (${candidate.name}) تعلم.`);
    }
  }
});

app.delete("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  appointments = appointments.filter((a) => a.id !== id);
  saveAppointments(appointments);
  res.json({ ok: true });
});

// ---------- API العمال ----------
app.get("/api/employees", (req, res) => {
  res.json(employees.map(e => ({ id: e.id, name: e.name, role: e.role || "", phone: e.phone || "", login: e.login || "", hasPassword: !!e.passwordHash })));
});

app.post("/api/employees", (req, res) => {
  const { name, role, phone, login, password } = req.body || {};
  if (!name || !login || !password) return res.status(400).json({ error: "خاصك تعمر الاسم والـ Login والـ Password" });
  if (employees.some(e => String(e.login || "").toLowerCase() === String(login).trim().toLowerCase())) {
    return res.status(409).json({ error: "هاد Login مستعمل من قبل" });
  }
  const { salt, hash } = hashEmployeePassword(password);
  const emp = { id: Date.now(), name: name.trim(), role: role || "", phone: phone || "", login: login.trim(), passwordSalt: salt, passwordHash: hash };
  employees.push(emp);
  saveEmployees(employees);
  res.json({ id: emp.id, name: emp.name, role: emp.role, phone: emp.phone, login: emp.login, hasPassword: true });
});

app.patch("/api/employees/:id", (req, res) => {
  const id = Number(req.params.id);
  const emp = employees.find(e => Number(e.id) === id);
  if (!emp) return res.status(404).json({ error: "العامل ماكاينش" });
  const { name, role, phone, login, password } = req.body || {};
  if (login && employees.some(e => Number(e.id) !== id && String(e.login || "").toLowerCase() === String(login).trim().toLowerCase())) {
    return res.status(409).json({ error: "هاد Login مستعمل من قبل" });
  }
  if (name !== undefined) emp.name = String(name).trim();
  if (role !== undefined) emp.role = role;
  if (phone !== undefined) emp.phone = phone;
  if (login !== undefined) emp.login = String(login).trim();
  if (password) {
    const { salt, hash } = hashEmployeePassword(password);
    emp.passwordSalt = salt; emp.passwordHash = hash; delete emp.password;
  }
  saveEmployees(employees);
  res.json({ id: emp.id, name: emp.name, role: emp.role, phone: emp.phone, login: emp.login, hasPassword: !!emp.passwordHash });
});

app.delete("/api/employees/:id", (req, res) => {
  const id = Number(req.params.id);
  employees = employees.filter((e) => Number(e.id) !== id);
  appointments.forEach(a => { if (Number(a.employeeId) === id) { a.employeeId = null; a.employee = ""; } });
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
  const appt = appointments.find((a) => a.id === id);
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
  const appt = appointments.find((a) => a.id === id);
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
  const appt = appointments.find((a) => a.id === id);
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  const { name, qty } = req.body;
  if (!name) return res.status(400).json({ error: "خاصك تعمر اسم القطعة" });
  const quantity = Number(qty) || 1;
  if (!appt.parts) appt.parts = [];
  appt.parts.push({ name, qty: quantity });
  // إلا كانت القطعة كاينة فالمخزون، ننقصو منو
  const item = inventory.find((i) => i.name.trim().toLowerCase() === name.trim().toLowerCase());
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
  const appt = appointments.find((a) => a.id === id);
  if (!appt || !appt.parts || !appt.parts[idx]) return res.status(404).json({ error: "غير موجود" });
  appt.parts.splice(idx, 1);
  saveAppointments(appointments);
  res.json(appt);
});

// ---------- API المخزون (قطع الغيار) ----------
app.get("/api/inventory", (req, res) => {
  res.json(inventory);
});

app.post("/api/inventory", (req, res) => {
  const { name, qty, unit } = req.body;
  if (!name) return res.status(400).json({ error: "خاصك تعمر اسم القطعة" });
  const item = { id: Date.now(), name, qty: Number(qty) || 0, unit: unit || "unité(s)" };
  inventory.push(item);
  saveInventory(inventory);
  res.json(item);
});

app.patch("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  const item = inventory.find((i) => i.id === id);
  if (!item) return res.status(404).json({ error: "غير موجود" });
  if (req.body.qty !== undefined) item.qty = Number(req.body.qty) || 0;
  if (req.body.name !== undefined) item.name = req.body.name;
  if (req.body.unit !== undefined) item.unit = req.body.unit;
  saveInventory(inventory);
  res.json(item);
});

app.delete("/api/inventory/:id", (req, res) => {
  const id = Number(req.params.id);
  inventory = inventory.filter((i) => i.id !== id);
  saveInventory(inventory);
  res.json({ ok: true });
});

// ---------- API لائحة الانتظار (waitlist) ----------
app.get("/api/waitlist", (req, res) => {
  res.json(waitlist);
});

app.post("/api/waitlist", (req, res) => {
  const { name, phone, car, service, preferredDate, issue } = req.body;
  if (!name || !car) return res.status(400).json({ error: "خاصك تعمر الاسم والسيارة" });
  const entry = {
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
  waitlist = waitlist.filter((w) => w.id !== id);
  saveWaitlist(waitlist);
  res.json({ ok: true });
});

// ---------- API الزبناء (مبني من المواعيد: كل المعلومات + التاريخ ديال كل زبون) ----------
app.get("/api/clients", (req, res) => {
  const map = new Map();
  appointments.forEach((a) => {
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
  res.json(invoices);
});

app.post("/api/invoices", (req, res) => {
  const { name, car, service, price, appointmentId, phone } = req.body;
  if (!name || !car || price === undefined || price === "") {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والثمن" });
  }
  const inv = {
    id: Date.now(),
    date: toISODate(new Date()),
    name,
    phone: phone || "",
    car,
    service: service || "-",
    price: Number(price),
    appointmentId: appointmentId || null,
  };
  invoices.push(inv);
  saveInvoices(invoices);
  res.json(inv);
});

app.delete("/api/invoices/:id", (req, res) => {
  const id = Number(req.params.id);
  invoices = invoices.filter((i) => i.id !== id);
  saveInvoices(invoices);
  res.json({ ok: true });
});

app.get("/api/invoices/:id/pdf", (req, res) => {
  const id = Number(req.params.id);
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return res.status(404).send("Facture introuvable");
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=facture-${inv.id}.pdf`);
  doc.pipe(res);
  addPdfHeader(doc, "Facture");
  doc.fontSize(11).fillColor("#000");
  doc.text(`N° Facture : ${inv.id}`);
  doc.text(`Date : ${inv.date}`);
  doc.moveDown();
  doc.text(`Client : ${inv.name}`);
  if (inv.phone) doc.text(`Téléphone : ${inv.phone}`);
  doc.text(`Véhicule : ${inv.car}`);
  doc.text(`Service : ${inv.service}`);
  doc.moveDown();
  doc.fontSize(16).text(`Total : ${inv.price} MAD`, { align: "right" });
  doc.end();
});

// ---------- en-tête مشترك للـ PDF (اللوغو + السمية) ----------
const LOGO_PATH = path.join(__dirname, "public", "logo.jpg");
function addPdfHeader(doc, subtitle) {
  const hasLogo = fs.existsSync(LOGO_PATH);
  if (hasLogo) {
    doc.image(LOGO_PATH, 40, 35, { width: 55, height: 55 });
  }
  doc
    .fontSize(18)
    .fillColor("#000")
    .text("SHAHD AUTOMOTIVE", hasLogo ? 105 : 40, 45);
  doc
    .fontSize(10)
    .fillColor("#555")
    .text(subtitle, hasLogo ? 105 : 40, 68);
  doc.moveTo(40, 100).lineTo(555, 100).strokeColor("#ccc").stroke();
  doc.y = 115;
}

// ---------- تصدير PDF (جدول: الاسم، السيارة، المشكل...) ----------
app.get("/api/appointments/pdf", (req, res) => {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=shahd-automotive-rendezvous.pdf");
  doc.pipe(res);

  addPdfHeader(doc, `Liste des rendez-vous — généré le ${new Date().toLocaleString("fr-FR")}`);

  // ---- جدول ----
  const cols = [
    { label: "Client", width: 75 },
    { label: "Véhicule", width: 80 },
    { label: "Problème", width: 110 },
    { label: "Date/Heure", width: 75 },
    { label: "Employé", width: 85 },
    { label: "Statut", width: 90 },
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
  appointments.forEach((a, i) => {
    drawRow(
      [a.name, a.car, a.issue || "-", `${a.date} ${a.time}`, a.employee || "-", a.status],
      { stripe: i % 2 === 1 }
    );
  });

  if (appointments.length === 0) {
    doc.fontSize(11).fillColor("#666").text("Aucun rendez-vous pour le moment.", 40, y + 10);
  }

  doc.end();
});

// ---------- تصدير PDF ديال موعد واحد بوحدو (بون دو ترافاي — فيه اسم العامل) ----------
app.get("/api/appointments/:id/pdf", (req, res) => {
  const id = Number(req.params.id);
  const a = appointments.find((x) => x.id === id);
  if (!a) return res.status(404).send("Rendez-vous introuvable");

  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=fiche-vehicule-${a.id}.pdf`);
  doc.pipe(res);

  addPdfHeader(doc, "Fiche véhicule / Bon de travail");

  doc.fontSize(11).fillColor("#000");
  if (a.code) doc.text(`Code de suivi : ${a.code}`);
  doc.text(`Date : ${a.date}    Heure : ${a.time}`);
  doc.moveDown();

  doc.fontSize(13).text("Client");
  doc.fontSize(11).fillColor("#333");
  doc.text(`Nom : ${a.name}`);
  if (a.phone) doc.text(`Téléphone : ${a.phone}`);
  doc.moveDown();

  doc.fillColor("#000").fontSize(13).text("Véhicule");
  doc.fontSize(11).fillColor("#333");
  doc.text(`Véhicule : ${a.car}`);
  doc.text(`Problème signalé : ${a.issue || "-"}`);
  doc.moveDown();

  doc.fillColor("#000").fontSize(13).text("Intervention");
  doc.fontSize(11).fillColor("#333");
  doc.text(`Service : ${a.service}`);
  doc.text(`Employé assigné : ${a.employee || "Non assigné"}`);
  doc.text(`Statut : ${a.status}`);

  doc.moveDown(2);
  doc.fontSize(9).fillColor("#888").text(`Généré le ${new Date().toLocaleString("fr-FR")}`);

  doc.end();
});

// ---------- تذكير أوتوماتيك يوم قبل الموعد (عبر تيليغرام، أو WhatsApp/SMS إلا كان الهاتف) ----------
function checkReminders() {
  const tomorrow = dateLabel(1).iso;
  appointments.forEach((appt) => {
    if (appt.date !== tomorrow) return;
    if (appt.status === "Annulé" || appt.status === "Terminé") return;
    if (appt.reminderSent) return;
    const msg = `⏰ تذكير: عندك موعد غدا (${appt.date} — ${appt.time}) ف SHAHD AUTOMOTIVE\n🚗 ${appt.car}\n🔧 ${appt.service}\n\nمرحبا بيك!`;
    if (appt.chatId) {
      bot.sendMessage(appt.chatId, msg).catch(() => {});
    } else if (appt.phone) {
      sendWhatsAppOrSMS(appt.phone, msg);
    }
    appt.reminderSent = true;
  });
  saveAppointments(appointments);
}
setTimeout(checkReminders, 10000); // فحص عند الإقلاع
setInterval(checkReminders, 30 * 60 * 1000); // فحص كل 30 دقيقة

app.listen(PORT, () => {
  console.log(`✅ السيرفر خدام على http://localhost:${PORT}`);
  console.log("✅ بوت تيليغرام خدام (polling)...");
  if (!OWNER_CHAT_ID) console.log("ℹ️ صيفط رسالة للبوت باش تعرف الـ chat id ديالك، ودير OWNER_CHAT_ID.");
});
