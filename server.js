// ===== SHAHD AUTOMOTIVE — Serveur (Telegram Bot + API + Dashboard) =====
const express = require("express");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ---------- الإعدادات ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // خاصك تعطيه القيمة (شوف README)
const PORT = process.env.PORT || 3000;
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

function slotsDisponibles() {
  const prisPar = new Set(appointments.map((a) => a.time));
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
    "أهلا بيك ف *SHAHD AUTOMOTIVE* 🚗🔧\nباغي نحجز ليك موعد. أول حاجة، شنو سميتك الكاملة؟",
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
      session.step = "time";
      const dispo = slotsDisponibles();
      if (dispo.length === 0) {
        bot.sendMessage(chatId, "معذرة، ماكاين حتى وقت متاح اليوم 🙏 عاود جرب غدا بـ /rdv");
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
      const dispo = slotsDisponibles();
      const idx = parseInt(text, 10) - 1;
      const time = dispo[idx];
      if (!time) {
        bot.sendMessage(chatId, "من فضلك كتب رقم صحيح من اللائحة.");
        return;
      }
      const appt = {
        id: Date.now(),
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
        `✅ تم تأكيد الموعد ديالك!\n\n👤 ${appt.name}\n🚗 ${appt.car}\n🔧 ${appt.service}\n🕐 ${appt.time}\n\nنتسناوك ف SHAHD AUTOMOTIVE!`
      );
      delete sessions[chatId];
      break;
    }
  }
});

// ---------- API باش الصفحة تقرا/تزيد المواعيد ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/appointments", (req, res) => {
  res.json(appointments);
});

app.post("/api/appointments", (req, res) => {
  const { name, car, service, time, status } = req.body;
  if (!name || !car || !time) {
    return res.status(400).json({ error: "خاصك تعمر الاسم، السيارة، والوقت" });
  }
  const appt = {
    id: Date.now(),
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
