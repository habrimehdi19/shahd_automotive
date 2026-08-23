// ===== HAYTAM AUTOMOTIVE — Serveur (Telegram Bot + API + Dashboard) =====
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ---------- الإعدادات ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // خاصك تعطيه القيمة (شوف README)
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "shahd2026"; // بدلها فـ Environment Variables
const DATA_FILE = path.join(__dirname, "appointments.json");

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

// ---------- البوت (polling، بلا حاجة لسيرفر HTTPS خارجي) ----------
const bot = new TelegramBot(TOKEN, { polling: true });

// حالة كل محادثة (كيتخزن فالذاكرة)
const sessions = {}; // chatId -> { step, data }

function reset(chatId) {
  sessions[chatId] = { step: "name", data: {} };
}

bot.onText(/\/start|\/rdv|موعد|rdv/i, (msg) => {
  const chatId = msg.chat.id;
  reset(chatId);
  bot.sendMessage(
    chatId,
    "أهلا بيك ف *HAYTAM AUTOMOTIVE* 🚗🔧\nباغي نحجز ليك موعد. أول حاجة، شنو سميتك الكاملة؟",
    { parse_mode: "Markdown" }
  );
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return; // الأوامر كيتقادو فوق

  if (!sessions[chatId]) {
    reset(chatId);
    bot.sendMessage(chatId, "أهلا! صيفط /rdv باش نبداو نحجزو ليك موعد 🚗");
    return;
  }

  const session = sessions[chatId];

  switch (session.step) {
    case "name":
      session.data.name = text;
      session.step = "car";
      bot.sendMessage(chatId, "شنو نوع السيارة ديالك؟ (مثلا: Toyota Corolla 2018)");
      break;

    case "car":
      session.data.car = text;
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
        bot.sendMessage(chatId, "معذرة، ماكاين حتى وقت متاح فهاد اليوم 🙏 عاود جرب بـ /rdv وختار يوم آخر");
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
        date: session.data.date,
        time,
        name: session.data.name,
        car: session.data.car,
        service: session.data.service,
        status: "Confirmé",
        source: "Telegram",
        chatId,
      };
      appointments.push(appt);
      saveAppointments(appointments);
      bot.sendMessage(
        chatId,
        `✅ تم تأكيد الموعد ديالك!\n\n👤 ${appt.name}\n🚗 ${appt.car}\n🔧 ${appt.service}\n📅 ${appt.date}\n🕐 ${appt.time}\n\nنتسناوك ف HAYTAM AUTOMOTIVE!`
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
  res.type("html").send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion — HAYTAM AUTOMOTIVE</title>
  <style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b0d;font-family:Arial,sans-serif}.box{background:#121518;border:1px solid #292e33;border-radius:14px;padding:28px;width:min(340px,90%)}h1{color:#fff;font-size:20px;margin:0 0 18px}input{width:100%;box-sizing:border-box;background:#0b0e10;border:1px solid #30363b;color:#fff;border-radius:8px;padding:12px;margin-bottom:12px;outline:none}button{width:100%;background:#ef2029;border:0;color:#fff;padding:13px;border-radius:8px;font-weight:700}
  .err{color:#ff6b6b;font-size:13px;margin-bottom:10px}</style></head><body>
  <form class="box" method="POST" action="/login">
    <h1>🔒 HAYTAM AUTOMOTIVE</h1>
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
  const { name, car, service, time, status, date } = req.body;
  if (!name || !car || !time) {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والوقت" });
  }
  const appt = {
    id: Date.now(),
    date: date || toISODate(new Date()),
    time,
    name,
    car,
    service: service || "Autre",
    status: status || "Confirmé",
    source: "Dashboard",
  };
  appointments.push(appt);
  saveAppointments(appointments);
  res.json(appt);
});

app.delete("/api/appointments/:id", (req, res) => {
  const id = Number(req.params.id);
  appointments = appointments.filter((a) => a.id !== id);
  saveAppointments(appointments);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ السيرفر خدام على http://localhost:${PORT}`);
  console.log("✅ بوت تيليغرام خدام (polling)...");
});
