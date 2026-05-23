const TelegramBot = require("node-telegram-bot-api");
const cron        = require("node-cron");
const express     = require("express");
const fs          = require("fs");
const path        = require("path");

// ── Config ──────────────────────────────────────────────────────────────────
const TOKEN        = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;       // Vercel URL
const REMIND_HOUR  = process.env.REMIND_HOUR || "7"; // giờ nhắc, VN time
const PORT         = process.env.PORT || 3000;
const DB_FILE      = path.join(__dirname, "users.json");

if (!TOKEN || !MINI_APP_URL) {
  console.error("❌  Thiếu BOT_TOKEN hoặc MINI_APP_URL trong .env");
  process.exit(1);
}

// ── Persistence ─────────────────────────────────────────────────────────────
let users = {};

function loadUsers() {
  try {
    if (fs.existsSync(DB_FILE)) users = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    console.log(`📂  Loaded ${Object.keys(users).length} users`);
  } catch (e) { console.error("loadUsers:", e.message); }
}

function saveUsers() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

loadUsers();

// ── Bot ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖  Bot started (polling)");

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  users[chatId] = { chatId, name: msg.from.first_name, joinedAt: new Date().toISOString() };
  saveUsers();

  bot.sendMessage(chatId,
    `Chào ${msg.from.first_name}! 👋\n\n` +
    `Mình là IELTS Study Bot của bạn.\n\n` +
    `📅 Mỗi sáng ${REMIND_HOUR}:00 mình sẽ nhắc bạn học.\n` +
    `📖 Nhấn nút bên dưới để mở app.\n\n` +
    `Lệnh:\n/today — xem plan hôm nay\n/stats — xem thống kê\n/remind — đặt lại giờ nhắc`,
    buildAppKeyboard()
  );
});

// /today
bot.onText(/\/today/, (msg) => sendDailyReminder(msg.chat.id));

// /stats
bot.onText(/\/stats/, (msg) => {
  const daysLeft = getDaysLeft();
  const weekNum  = getWeekNum();
  const phase    = getPhase();
  bot.sendMessage(msg.chat.id,
    `📊 *Thống kê lộ trình*\n\n` +
    `⏰ Còn *${daysLeft} ngày* đến kỳ thi\n` +
    `📌 Tuần *${weekNum}/12* · Phase *${phase}*: ${getPhaseLabel(phase)}\n\n` +
    `🎯 Mục tiêu: Overall *8.0*\n` +
    `• Reading: 8.5\n• Listening: 8.5\n• Writing: 7.0\n• Speaking: 8.0`,
    { parse_mode: "Markdown", ...buildAppKeyboard() }
  );
});

// /remind HH
bot.onText(/\/remind(?:\s+(\d{1,2}))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const hour   = parseInt(match?.[1]);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    return bot.sendMessage(chatId, "Dùng: /remind 7 (để nhắc lúc 7:00 sáng)");
  }
  if (!users[chatId]) users[chatId] = { chatId, name: msg.from.first_name };
  users[chatId].remindHour = hour;
  saveUsers();
  bot.sendMessage(chatId, `✅ Đã đặt nhắc nhở lúc ${hour}:00 mỗi ngày.`);
});

// Unknown command
bot.on("message", (msg) => {
  if (!msg.text?.startsWith("/")) return;
  const known = ["/start", "/today", "/stats", "/remind"];
  if (!known.some(c => msg.text.startsWith(c))) {
    bot.sendMessage(msg.chat.id, "Lệnh không hợp lệ. Dùng /start để xem hướng dẫn.");
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function getDaysLeft() {
  return Math.max(0, Math.ceil((new Date("2026-08-15") - new Date()) / 864e5));
}

function getWeekNum() {
  return Math.min(12, Math.max(1, Math.ceil((new Date() - new Date("2026-05-23")) / (7 * 864e5))));
}

function getPhase() {
  const d = Math.floor((new Date() - new Date("2026-05-23")) / 864e5);
  return d < 28 ? 1 : d < 56 ? 2 : 3;
}

function getPhaseLabel(p) {
  return ["","Foundation","Intensive","Mock & Refine"][p];
}

function getMotivation() {
  const msgs = [
    "Mỗi ngày một bước, mục tiêu 8.0 không xa! 💪",
    "Consistency beats talent. Học đều hơn học nhiều! 🔥",
    "Hôm nay đầu tư, kỳ thi thu hoạch. Let's go! 🎯",
    "Band 8.0 không phải may mắn — đó là kết quả hôm nay! ⭐",
    "Bạn đã học bao nhiêu ngày rồi. Đừng bỏ hôm nay! 📚",
  ];
  return msgs[new Date().getDay() % msgs.length];
}

function buildAppKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "📖 Mở IELTS App", web_app: { url: MINI_APP_URL } }
      ]]
    }
  };
}

function sendDailyReminder(chatId) {
  const daysLeft = getDaysLeft();
  const weekNum  = getWeekNum();
  const phase    = getPhase();
  const today    = new Date().toLocaleDateString("vi-VN", { weekday:"long", day:"numeric", month:"numeric" });

  const text =
    `☀️ *Chào buổi sáng!*\n\n` +
    `📅 ${today}\n` +
    `⏰ Còn *${daysLeft} ngày* đến kỳ thi\n` +
    `📌 Tuần ${weekNum}/12 · Phase ${phase}: ${getPhaseLabel(phase)}\n\n` +
    `✅ *Kế hoạch hôm nay:*\n` +
    `🟣 Vocab review — 15'\n` +
    `🟢 Speaking — 20' (luyennoi.com)\n` +
    `🔵 Reading — 75' (study4.com)\n` +
    `🟡 Listening — 60' (study4.com)\n` +
    `🔴 Writing — 100' (AI examiner)\n\n` +
    `_${getMotivation()}_`;

  bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...buildAppKeyboard() });
}

// ── Cron: gửi nhắc theo giờ của từng user (hoặc REMIND_HOUR mặc định) ──────
// Chạy mỗi phút để kiểm tra — so sánh giờ VN hiện tại
cron.schedule("* * * * *", () => {
  const now = new Date().toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour:"2-digit", minute:"2-digit", hour12:false
  });
  const [h, m] = now.split(":").map(Number);
  if (m !== 0) return; // chỉ chạy đúng đầu giờ

  Object.values(users).forEach(user => {
    const userHour = user.remindHour ?? parseInt(REMIND_HOUR);
    if (h === userHour) {
      console.log(`📬  Sending reminder to ${user.name} (${user.chatId})`);
      sendDailyReminder(user.chatId);
    }
  });
}, { timezone: "Asia/Ho_Chi_Minh" });

// ── Express health check ─────────────────────────────────────────────────────
const app = express();
app.get("/",         (_, res) => res.json({ status:"ok", users: Object.keys(users).length }));
app.get("/ping",     (_, res) => res.send("pong"));
app.get("/users",    (_, res) => res.json({ count: Object.keys(users).length }));
app.listen(PORT, () => console.log(`🌐  Express on port ${PORT}`));

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => { saveUsers(); process.exit(0); });
process.on("SIGINT",  () => { saveUsers(); process.exit(0); });
