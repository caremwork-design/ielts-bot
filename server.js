const TelegramBot = require("node-telegram-bot-api");
const cron        = require("node-cron");
const express     = require("express");
const fs          = require("fs");
const path        = require("path");

// ── Config ───────────────────────────────────────────────────────────────────
const TOKEN         = process.env.BOT_TOKEN;
const MINI_APP_URL  = process.env.MINI_APP_URL;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const REMIND_HOUR   = process.env.REMIND_HOUR || "7";
const PORT          = process.env.PORT || 3000;
const DB_FILE       = path.join(__dirname, "users.json");

if (!TOKEN || !MINI_APP_URL) {
  console.error("❌  Thiếu BOT_TOKEN hoặc MINI_APP_URL"); process.exit(1);
}

// ── Models config ────────────────────────────────────────────────────────────
const MODELS = {
  "gpt-4o-mini": {
    label:    "GPT-4o Mini",
    provider: "openai",
    model:    "gpt-4o-mini",
    desc:     "Nhanh · Rẻ nhất · Đủ dùng hàng ngày"
  },
  "gpt-4o": {
    label:    "GPT-4o",
    provider: "openai",
    model:    "gpt-4o",
    desc:     "Mạnh hơn · Chậm hơn chút · Tốt cho câu phức tạp"
  },
  "claude-haiku": {
    label:    "Claude Haiku",
    provider: "anthropic",
    model:    "claude-haiku-4-5-20251001",
    desc:     "Nhanh · Rẻ · Của Anthropic"
  },
  "claude-sonnet": {
    label:    "Claude Sonnet",
    provider: "anthropic",
    model:    "claude-sonnet-4-6",
    desc:     "Mạnh nhất · Chậm hơn · Tốt nhất cho Writing feedback"
  },
};

const DEFAULT_MODEL = "gpt-4o-mini";

// ── Persistence ──────────────────────────────────────────────────────────────
let users = {};
function loadUsers() {
  try { if (fs.existsSync(DB_FILE)) users = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch(e) {}
}
function saveUsers() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); } catch(e) {}
}
loadUsers();

function getModel(chatId) {
  return users[chatId]?.model || DEFAULT_MODEL;
}

// ── AI Calls ─────────────────────────────────────────────────────────────────
async function callOpenAI(modelId, systemPrompt, userMsg, maxTokens = 600) {
  if (!OPENAI_KEY) return "Chưa cấu hình OPENAI_API_KEY.";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [
          { role:"system", content: systemPrompt },
          { role:"user",   content: userMsg }
        ]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "Không có phản hồi.";
  } catch(e) {
    console.error("OpenAI error:", e.message);
    return `❌ Lỗi OpenAI: ${e.message}`;
  }
}

async function callAnthropic(modelId, systemPrompt, userMsg, maxTokens = 600) {
  if (!ANTHROPIC_KEY) return "Chưa cấu hình ANTHROPIC_API_KEY.";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role:"user", content: userMsg }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text || "Không có phản hồi.";
  } catch(e) {
    console.error("Anthropic error:", e.message);
    return `❌ Lỗi Anthropic: ${e.message}`;
  }
}

async function callAI(chatId, systemPrompt, userMsg, maxTokens = 600) {
  const modelKey = getModel(chatId);
  const cfg      = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  if (cfg.provider === "openai")     return callOpenAI(cfg.model, systemPrompt, userMsg, maxTokens);
  if (cfg.provider === "anthropic")  return callAnthropic(cfg.model, systemPrompt, userMsg, maxTokens);
  return "Model không hợp lệ.";
}

// ── AI Tasks ─────────────────────────────────────────────────────────────────
async function getWordInfo(chatId, word) {
  const system = `Bạn là từ điển IELTS. Chỉ trả về JSON thuần túy, không markdown.`;
  const prompt = `Tra từ: "${word}"
Trả về JSON:
{
  "word": "${word}",
  "meaning": "nghĩa tiếng Việt ngắn gọn",
  "example": "1 câu ví dụ IELTS, tiếng Anh",
  "topic": "Education/Technology/Environment/Society/Health/Employment/Government/Law & Crime",
  "collocations": ["collocation 1", "collocation 2"]
}`;
  try {
    const text = await callAI(chatId, system, prompt, 300);
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e) {
    return { word, meaning:"Không tra được", example:"", topic:"General", collocations:[] };
  }
}

async function getIELTSChat(chatId, userMsg) {
  const system = `Bạn là gia sư IELTS thân thiện, chuyên sâu. Trả lời tiếng Việt, dưới 200 từ. Dùng emoji vừa phải. Tập trung band 8.0. Chỉ dùng *bold* và _italic_ khi cần.`;
  return callAI(chatId, system, userMsg, 600);
}

// ── Bot ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖  Bot started");

const chatHistory = {};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  users[chatId] = { chatId, name:msg.from.first_name, joinedAt:new Date().toISOString(), model:DEFAULT_MODEL };
  saveUsers();
  const cfg = MODELS[DEFAULT_MODEL];
  bot.sendMessage(chatId,
    `Chào ${msg.from.first_name}! 👋\n\n` +
    `Mình là IELTS Study Bot 🎯\n\n` +
    `*Lệnh:*\n` +
    `📖 Tra từ → gõ từ tiếng Anh bất kỳ\n` +
    `💬 Chat IELTS → hỏi gì cũng được\n` +
    `🤖 Đổi AI → /model\n` +
    `📅 Plan hôm nay → /today\n` +
    `📊 Thống kê → /stats\n` +
    `⏰ Đổi giờ nhắc → /remind 7\n` +
    `🗑 Xóa lịch sử → /clear\n\n` +
    `Model hiện tại: *${cfg.label}*`,
    { parse_mode:"Markdown", ...buildAppKeyboard() }
  );
});

bot.onText(/\/model/, (msg) => {
  const chatId   = msg.chat.id;
  const current  = getModel(chatId);
  const keyboard = Object.entries(MODELS).map(([key, cfg]) => [{
    text: `${current===key?"✅ ":""}${cfg.label} — ${cfg.desc}`,
    callback_data: `model_${key}`
  }]);
  bot.sendMessage(chatId,
    `🤖 *Chọn model AI*\n\nHiện tại: *${MODELS[current].label}*`,
    { parse_mode:"Markdown", reply_markup: { inline_keyboard: keyboard } }
  );
});

// Xử lý callback khi chọn model
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  if (!data.startsWith("model_")) return;

  const modelKey = data.replace("model_","");
  if (!MODELS[modelKey]) return;

  const cfg = MODELS[modelKey];

  // Kiểm tra API key có sẵn không
  if (cfg.provider==="openai" && !OPENAI_KEY) {
    bot.answerCallbackQuery(query.id, { text:"❌ Chưa có OPENAI_API_KEY", show_alert:true });
    return;
  }
  if (cfg.provider==="anthropic" && !ANTHROPIC_KEY) {
    bot.answerCallbackQuery(query.id, { text:"❌ Chưa có ANTHROPIC_API_KEY", show_alert:true });
    return;
  }

  if (!users[chatId]) users[chatId] = { chatId, name:query.from.first_name };
  users[chatId].model = modelKey;
  saveUsers();

  // Xóa lịch sử chat khi đổi model
  chatHistory[chatId] = [];

  bot.answerCallbackQuery(query.id, { text:`✅ Đã chuyển sang ${cfg.label}` });
  bot.editMessageText(
    `✅ Đã chuyển sang *${cfg.label}*\n\n_${cfg.desc}_\n\nLịch sử chat đã được xóa.`,
    { chat_id:chatId, message_id:query.message.message_id, parse_mode:"Markdown" }
  );
});

bot.onText(/\/today/, (msg) => sendDailyReminder(msg.chat.id));

bot.onText(/\/stats/, (msg) => {
  const chatId  = msg.chat.id;
  const current = getModel(chatId);
  bot.sendMessage(chatId,
    `📊 *Thống kê lộ trình*\n\n` +
    `⏰ Còn *${getDaysLeft()} ngày* đến kỳ thi\n` +
    `📌 Tuần *${getWeekNum()}/12* · Phase *${getPhase()}*: ${getPhaseLabel(getPhase())}\n\n` +
    `🎯 *Mục tiêu: Overall 8.0*\n` +
    `• Reading: 8.5\n• Listening: 8.5\n• Writing: 7.0\n• Speaking: 8.0\n\n` +
    `🤖 Model hiện tại: *${MODELS[current].label}*`,
    { parse_mode:"Markdown", ...buildAppKeyboard() }
  );
});

bot.onText(/\/remind(?:\s+(\d{1,2}))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const hour   = parseInt(match?.[1]);
  if (isNaN(hour)||hour<0||hour>23)
    return bot.sendMessage(chatId,"Dùng: /remind 7");
  if (!users[chatId]) users[chatId] = { chatId, name:msg.from.first_name };
  users[chatId].remindHour = hour;
  saveUsers();
  bot.sendMessage(chatId,`✅ Đã đặt nhắc lúc *${hour}:00* mỗi ngày.`,{parse_mode:"Markdown"});
});

bot.onText(/\/clear/, (msg) => {
  chatHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id,"🗑 Đã xóa lịch sử chat.");
});

// Tin nhắn thường
bot.on("message", async (msg) => {
  if (!msg.text||msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const model  = MODELS[getModel(chatId)];

  bot.sendChatAction(chatId,"typing");

  const isVocabLookup = /^[a-zA-Z][\w\s-]{0,30}$/.test(text) && text.split(" ").length<=3;

  if (isVocabLookup) {
    const info  = await getWordInfo(chatId, text);
    const colls = info.collocations?.length ? `\n\n🔗 *Collocations:* ${info.collocations.join(", ")}` : "";
    const appUrl = `${MINI_APP_URL}?word=${encodeURIComponent(info.word)}&meaning=${encodeURIComponent(info.meaning)}&example=${encodeURIComponent(info.example)}&tag=${encodeURIComponent(info.topic)}`;

    bot.sendMessage(chatId,
      `📖 *${info.word}*\n\n🇻🇳 ${info.meaning}\n\n💬 _"${info.example}"_\n\n🏷 Topic: ${info.topic}${colls}\n\n_via ${model.label}_`,
      {
        parse_mode:"Markdown",
        reply_markup:{ inline_keyboard:[[
          { text:"➕ Thêm vào Vault", web_app:{ url:appUrl } }
        ],[
          { text:"📖 Mở App", web_app:{ url:MINI_APP_URL } }
        ]]}
      }
    );
  } else {
    if (!chatHistory[chatId]) chatHistory[chatId] = [];
    const reply = await getIELTSChat(chatId, text);
    chatHistory[chatId].push({role:"user",content:text},{role:"assistant",content:reply});
    if (chatHistory[chatId].length>20) chatHistory[chatId]=chatHistory[chatId].slice(-20);
    bot.sendMessage(chatId, `${reply}\n\n_via ${model.label}_`, {parse_mode:"Markdown",...buildAppKeyboard()});
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function getDaysLeft()   { return Math.max(0,Math.ceil((new Date("2026-08-15")-new Date())/864e5)); }
function getWeekNum()    { return Math.min(12,Math.max(1,Math.ceil((new Date()-new Date("2026-05-23"))/(7*864e5)))); }
function getPhase()      { const d=Math.floor((new Date()-new Date("2026-05-23"))/864e5); return d<28?1:d<56?2:3; }
function getPhaseLabel(p){ return ["","Foundation","Intensive","Mock & Refine"][p]; }
function getMotivation() { return ["Mỗi ngày một bước, 8.0 không xa! 💪","Consistency beats talent! 🔥","Hôm nay đầu tư, kỳ thi thu hoạch! 🎯","Band 8.0 là kết quả của hôm nay! ⭐","Đừng bỏ hôm nay nhé! 📚"][new Date().getDay()%5]; }
function buildAppKeyboard(){ return {reply_markup:{inline_keyboard:[[{text:"📖 Mở IELTS App",web_app:{url:MINI_APP_URL}}]]}}; }

function sendDailyReminder(chatId) {
  const today = new Date().toLocaleDateString("vi-VN",{weekday:"long",day:"numeric",month:"numeric"});
  bot.sendMessage(chatId,
    `☀️ *Chào buổi sáng!*\n\n📅 ${today}\n⏰ Còn *${getDaysLeft()} ngày* đến kỳ thi\n` +
    `📌 Tuần ${getWeekNum()}/12 · Phase ${getPhase()}: ${getPhaseLabel(getPhase())}\n\n` +
    `✅ *Kế hoạch hôm nay:*\n🟣 Vocab — 15'\n🟢 Speaking — 20'\n🔵 Reading — 75'\n🟡 Listening — 60'\n🔴 Writing — 100'\n\n` +
    `_${getMotivation()}_`,
    {parse_mode:"Markdown",...buildAppKeyboard()}
  );
}

// ── Cron ─────────────────────────────────────────────────────────────────────
cron.schedule("* * * * *", () => {
  const now  = new Date().toLocaleTimeString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh",hour:"2-digit",minute:"2-digit",hour12:false});
  const [h,m]= now.split(":").map(Number);
  if (m!==0) return;
  Object.values(users).forEach(u => {
    if (h===(u.remindHour??parseInt(REMIND_HOUR))) sendDailyReminder(u.chatId);
  });
},{timezone:"Asia/Ho_Chi_Minh"});

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.get("/", (_, res) => res.json({ status:"ok", users:Object.keys(users).length }));
app.get("/ping", (_, res) => res.send("pong"));
app.listen(PORT, () => console.log(`🌐  Express on port ${PORT}`));
process.on("SIGTERM",()=>{saveUsers();process.exit(0);});
process.on("SIGINT", ()=>{saveUsers();process.exit(0);});