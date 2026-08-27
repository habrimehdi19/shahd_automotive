// ===== SHAHD AUTOMOTIVE — Serveur (Telegram Bot + API + Dashboard) =====
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ---------- الإعدادات ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // خاصك تعطيه القيمة (شوف README)
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "shahd2026"; // بدلها فـ Environment Variables
const DATA_FILE = path.join(__dirname, "appointments.json");
const EMPLOYEES_FILE = path.join(__dirname, "employees.json");

if (!TOKEN) {
  console.error("❌ خاصك تدير TELEGRAM_BOT_TOKEN. شوف ملف README.md");
  process.exit(1);
}

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
      session.step = "time";
      const dispo = slotsDisponibles(chosen.iso);
      if (dispo.length === 0) {
        bot.sendMessage(chatId, "معذرة، ماكاين حتى وقت متاح فهاد اليوم 🙏 عاود جرب /start وختار يوم آخر");
        delete sessions[chatId];
        return;
      }
      bot.sendMessage(
        chatId,
        "فأي وقت تفضل؟\n" + dispo.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n\nكتب رقم الوقت."
      );
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
      };
      appointments.push(appt);
      saveAppointments(appointments);
      bot.sendMessage(
        chatId,
        `✅ تم تأكيد الموعد ديالك!\n\n👤 ${appt.name}\n📞 ${appt.phone}\n🚗 ${appt.car}\n🔧 ${appt.service}\n📅 ${appt.date}\n🕐 ${appt.time}\n\n🔑 رقم التتبع ديالك: *${appt.code}*\n(احتفظ بيه، غايتطلب منك من بعد)\n\nنتسناوك ف SHAHD AUTOMOTIVE!`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      delete sessions[chatId];
      break;
    }
  }
});

// ---------- API باش الصفحة تقرا/تزيد المواعيد ----------
const app = express();
app.use(express.json());

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

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/appointments", (req, res) => {
  res.json(appointments);
});

app.post("/api/appointments", (req, res) => {
  const { name, car, service, time, status, date, issue, employee, phone } = req.body;
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
    source: "Dashboard",
  };
  appointments.push(appt);
  saveAppointments(appointments);
  res.json(appt);
});

app.patch("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  const appt = appointments.find((a) => a.id === id);
  if (!appt) return res.status(404).json({ error: "الموعد ماكاينش" });
  if (req.body.employee !== undefined) appt.employee = req.body.employee;
  if (req.body.status !== undefined) appt.status = req.body.status;
  saveAppointments(appointments);
  res.json(appt);
});

app.delete("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  appointments = appointments.filter((a) => a.id !== id);
  saveAppointments(appointments);
  res.json({ ok: true });
});

// ---------- API العمال ----------
app.get("/api/employees", (req, res) => {
  res.json(employees);
});

app.post("/api/employees", (req, res) => {
  const { name, role, phone } = req.body;
  if (!name) return res.status(400).json({ error: "خاصك تعمر الاسم" });
  const emp = { id: Date.now(), name, role: role || "", phone: phone || "" };
  employees.push(emp);
  saveEmployees(employees);
  res.json(emp);
});

app.delete("/api/employees/:id", (req, res) => {
  const id = Number(req.params.id);
  employees = employees.filter((e) => e.id !== id);
  saveEmployees(employees);
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

app.listen(PORT, () => {
  console.log(`✅ السيرفر خدام على http://localhost:${PORT}`);
  console.log("✅ بوت تيليغرام خدام (polling)...");
});
