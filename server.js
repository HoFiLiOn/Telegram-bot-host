const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const DATA_DIR = path.join(ROOT, 'data');
const BOTS_DIR = path.join(DATA_DIR, 'bots');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);

ensureDir(DATA_DIR);
ensureDir(BOTS_DIR);

const db = loadDb();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return crypto.randomBytes(8).toString('hex');
}

function defaultDb() {
  return { bots: [] };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = defaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed.bots || !Array.isArray(parsed.bots)) parsed.bots = [];
    for (const bot of parsed.bots) {
      bot.logs = Array.isArray(bot.logs) ? bot.logs : [];
      bot.storage = bot.storage && typeof bot.storage === 'object' ? bot.storage : {};
      bot.offset = Number(bot.offset || 0);
      bot.autostart = Boolean(bot.autostart);
      bot.entryFile = normalizeEntryFile(bot.entryFile || 'bot.js');
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read DB, recreating:', error);
    const seed = defaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function findBot(botId) {
  return db.bots.find((item) => item.id === botId) || null;
}

function sanitizeToken(token) {
  return String(token || '').trim();
}

function maskToken(token) {
  const value = sanitizeToken(token);
  if (!value) return '';
  if (value.length <= 10) return '••••••';
  return `${value.slice(0, 6)}••••••${value.slice(-4)}`;
}

function normalizePathInput(relPath) {
  const value = String(relPath || '').replace(/\\/g, '/').trim();
  const normalized = path.posix.normalize(value).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new Error('Некорректный путь файла');
  }
  return normalized;
}

function normalizeEntryFile(filePath) {
  try {
    return normalizePathInput(filePath || 'bot.js');
  } catch (_) {
    return 'bot.js';
  }
}

function botRoot(botId) {
  return path.join(BOTS_DIR, botId);
}

function resolveBotFile(botId, relPath = '') {
  const root = botRoot(botId);
  ensureDir(root);
  if (!relPath) return root;
  const normalized = normalizePathInput(relPath);
  const fullPath = path.join(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Выход за пределы папки бота запрещён');
  }
  return fullPath;
}

function ensureDefaultHandler(botId) {
  const targetFile = resolveBotFile(botId, 'bot.js');
  if (!fs.existsSync(targetFile)) {
    const templatePath = path.join(TEMPLATE_DIR, 'default-handler.js');
    const template = fs.readFileSync(templatePath, 'utf8');
    fs.writeFileSync(targetFile, template);
  }
}

function listFilesRecursive(dirPath, prefix = '') {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFilesRecursive(full, rel));
    } else {
      const stat = fs.statSync(full);
      result.push({
        path: rel.replace(/\\/g, '/'),
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function deleteDirectoryRecursive(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneLogs(bot) {
  bot.logs = (bot.logs || []).slice(-250);
}

function appendLog(botId, message) {
  const bot = findBot(botId);
  if (!bot) return;
  bot.logs = bot.logs || [];
  bot.logs.push({
    at: nowIso(),
    message: String(message)
  });
  pruneLogs(bot);
  saveDb();
}

function serializeBot(bot) {
  return {
    id: bot.id,
    name: bot.name,
    entryFile: bot.entryFile,
    autostart: Boolean(bot.autostart),
    running: manager.isRunning(bot.id),
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    lastStartedAt: bot.lastStartedAt || null,
    lastStoppedAt: bot.lastStoppedAt || null,
    maskedToken: maskToken(bot.token),
    offset: Number(bot.offset || 0),
    files: listFilesRecursive(botRoot(bot.id)),
    logs: (bot.logs || []).slice(-80),
    storageKeys: Object.keys(bot.storage || {}).length
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Невалидный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon'
  };
  return map[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  let target = pathname === '/' ? '/index.html' : pathname;
  target = path.normalize(target).replace(/^\.+/, '');
  const filePath = path.join(PUBLIC_DIR, target);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, 'Not found');
    return;
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

function telegramRequest(token, method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.ok) {
              reject(new Error(parsed.description || `Telegram API error (${method})`));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(new Error(`Telegram response parse error: ${raw}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSandboxConsole(botId) {
  return {
    log: (...args) => appendLog(botId, `[console.log] ${args.map(formatLogValue).join(' ')}`),
    error: (...args) => appendLog(botId, `[console.error] ${args.map(formatLogValue).join(' ')}`),
    warn: (...args) => appendLog(botId, `[console.warn] ${args.map(formatLogValue).join(' ')}`),
    info: (...args) => appendLog(botId, `[console.info] ${args.map(formatLogValue).join(' ')}`)
  };
}

function formatLogValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function loadBotExports(bot) {
  const root = botRoot(bot.id);
  const files = {};
  const fileList = listFilesRecursive(root);
  for (const item of fileList) {
    const full = resolveBotFile(bot.id, item.path);
    files[item.path] = fs.readFileSync(full, 'utf8');
  }

  const cache = new Map();

  function executeModule(relPath) {
    const normalized = normalizePathInput(relPath);

    if (cache.has(normalized)) {
      return cache.get(normalized).exports;
    }

    if (normalized.endsWith('.json')) {
      if (!Object.prototype.hasOwnProperty.call(files, normalized)) {
        throw new Error(`Файл не найден: ${normalized}`);
      }
      const module = { exports: JSON.parse(files[normalized]) };
      cache.set(normalized, module);
      return module.exports;
    }

    if (!Object.prototype.hasOwnProperty.call(files, normalized)) {
      throw new Error(`Файл не найден: ${normalized}`);
    }

    const code = files[normalized];
    const module = { exports: {} };
    cache.set(normalized, module);

    const localRequire = (request) => {
      if (typeof request !== 'string') {
        throw new Error('require() принимает только строку');
      }
      if (!request.startsWith('.')) {
        throw new Error('Разрешены только относительные require("./...")');
      }
      const baseDir = path.posix.dirname(normalized);
      let target = path.posix.normalize(path.posix.join(baseDir, request));
      if (!path.posix.extname(target)) {
        if (Object.prototype.hasOwnProperty.call(files, `${target}.js`)) target = `${target}.js`;
        else if (Object.prototype.hasOwnProperty.call(files, `${target}.json`)) target = `${target}.json`;
      }
      return executeModule(target);
    };

    const sandbox = {
      module,
      exports: module.exports,
      require: localRequire,
      console: makeSandboxConsole(bot.id),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      Promise
    };

    const context = vm.createContext(sandbox);
    const wrapper = new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${code}\n})`, {
      filename: normalized,
      displayErrors: true
    });
    const compiled = wrapper.runInContext(context, { timeout: 1000 });
    compiled(module.exports, localRequire, module, normalized, path.posix.dirname(normalized));
    return module.exports;
  }

  const exports = executeModule(bot.entryFile || 'bot.js');
  if (!exports || typeof exports !== 'object') {
    throw new Error('Главный файл должен экспортировать объект через module.exports');
  }
  return exports;
}

function createContext(bot, update) {
  const message = update.message || update.edited_message || update.callback_query?.message || null;
  const callbackQuery = update.callback_query || null;
  const text = update.message?.text || update.edited_message?.text || '';
  const chatId = message?.chat?.id || callbackQuery?.message?.chat?.id || null;
  const commandMatch = text && text.startsWith('/') ? text.match(/^\/([^\s@]+)(?:@[^\s]+)?(?:\s+(.*))?$/) : null;
  const command = commandMatch ? commandMatch[1] : '';
  const args = commandMatch && commandMatch[2] ? commandMatch[2].trim().split(/\s+/).filter(Boolean) : [];

  return {
    update,
    message,
    callbackQuery,
    text,
    command,
    args,
    chatId,
    from: update.message?.from || update.edited_message?.from || update.callback_query?.from || null,
    storage: {
      get(key) {
        return bot.storage?.[key];
      },
      set(key, value) {
        bot.storage = bot.storage || {};
        bot.storage[key] = value;
        bot.updatedAt = nowIso();
        saveDb();
        return value;
      },
      delete(key) {
        if (bot.storage) {
          delete bot.storage[key];
          bot.updatedAt = nowIso();
          saveDb();
        }
      },
      all() {
        return JSON.parse(JSON.stringify(bot.storage || {}));
      }
    },
    async api(method, payload) {
      return telegramRequest(bot.token, method, payload);
    },
    async sendMessage(targetChatId, content, extra = {}) {
      return telegramRequest(bot.token, 'sendMessage', {
        chat_id: targetChatId,
        text: String(content),
        ...extra
      });
    },
    async reply(content, extra = {}) {
      if (!chatId) throw new Error('chatId не найден в update');
      return telegramRequest(bot.token, 'sendMessage', {
        chat_id: chatId,
        text: String(content),
        ...extra
      });
    },
    async answerCallbackQuery(extra = {}) {
      if (!callbackQuery?.id) throw new Error('callback_query отсутствует');
      return telegramRequest(bot.token, 'answerCallbackQuery', {
        callback_query_id: callbackQuery.id,
        ...extra
      });
    }
  };
}

class BotRunner {
  constructor(bot) {
    this.bot = bot;
    this.running = false;
    this.loopPromise = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.bot.lastStartedAt = nowIso();
    this.bot.updatedAt = nowIso();
    appendLog(this.bot.id, 'Бот запущен');
    saveDb();
    this.loopPromise = this.loop();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.bot.lastStoppedAt = nowIso();
    this.bot.updatedAt = nowIso();
    appendLog(this.bot.id, 'Бот остановлен');
    saveDb();
  }

  async loop() {
    while (this.running) {
      try {
        const updates = await telegramRequest(this.bot.token, 'getUpdates', {
          timeout: 50,
          offset: Number(this.bot.offset || 0),
          allowed_updates: ['message', 'edited_message', 'callback_query']
        });

        for (const update of updates) {
          if (!this.running) break;
          this.bot.offset = Number(update.update_id) + 1;
          saveDb();
          await this.handleUpdate(update);
        }
      } catch (error) {
        appendLog(this.bot.id, `Ошибка long polling: ${error.message}`);
        await sleep(2500);
      }
    }
  }

  async handleUpdate(update) {
    try {
      const handlers = loadBotExports(this.bot);
      const ctx = createContext(this.bot, update);

      if (update.callback_query && typeof handlers.onCallbackQuery === 'function') {
        await handlers.onCallbackQuery(ctx);
      }

      if (ctx.command && typeof handlers.onCommand === 'function') {
        await handlers.onCommand(ctx);
      }

      if (ctx.text && !ctx.command && typeof handlers.onText === 'function') {
        await handlers.onText(ctx);
      }

      if ((update.message || update.edited_message) && typeof handlers.onMessage === 'function') {
        await handlers.onMessage(ctx);
      }

      if (typeof handlers.onUpdate === 'function') {
        await handlers.onUpdate(ctx);
      }
    } catch (error) {
      appendLog(this.bot.id, `Ошибка обработчика: ${error.stack || error.message}`);
    }
  }
}

class BotManager {
  constructor() {
    this.runners = new Map();
  }

  isRunning(botId) {
    return this.runners.has(botId);
  }

  start(botId) {
    const bot = findBot(botId);
    if (!bot) throw new Error('Бот не найден');
    if (!sanitizeToken(bot.token)) throw new Error('У бота не задан Telegram token');
    ensureDefaultHandler(bot.id);
    if (this.runners.has(botId)) return;
    const runner = new BotRunner(bot);
    this.runners.set(botId, runner);
    runner.start();
  }

  stop(botId) {
    const runner = this.runners.get(botId);
    if (!runner) return;
    runner.stop();
    this.runners.delete(botId);
  }

  restore() {
    for (const bot of db.bots) {
      if (bot.autostart) {
        try {
          this.start(bot.id);
        } catch (error) {
          appendLog(bot.id, `Не удалось автозапустить: ${error.message}`);
        }
      }
    }
  }
}

const manager = new BotManager();
manager.restore();

function getUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

async function handleApi(req, res, pathname, searchParams) {
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'telegram-bot-host', time: nowIso() });
    return;
  }

  if (pathname === '/api/bots' && req.method === 'GET') {
    sendJson(res, 200, { bots: db.bots.map(serializeBot) });
    return;
  }

  if (pathname === '/api/bots' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    const token = sanitizeToken(body.token);
    const entryFile = normalizeEntryFile(body.entryFile || 'bot.js');

    if (!name) {
      sendJson(res, 400, { error: 'Введите имя бота' });
      return;
    }
    if (!token) {
      sendJson(res, 400, { error: 'Введите Telegram token' });
      return;
    }

    const bot = {
      id: createId(),
      name,
      token,
      entryFile,
      autostart: Boolean(body.autostart),
      offset: 0,
      logs: [],
      storage: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastStartedAt: null,
      lastStoppedAt: null
    };

    db.bots.push(bot);
    ensureDir(botRoot(bot.id));
    ensureDefaultHandler(bot.id);
    appendLog(bot.id, 'Бот создан');
    saveDb();
    if (bot.autostart) {
      try {
        manager.start(bot.id);
      } catch (error) {
        appendLog(bot.id, `Автозапуск после создания не удался: ${error.message}`);
      }
    }
    sendJson(res, 201, { bot: serializeBot(bot) });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'bots' && parts[2]) {
    const botId = parts[2];
    const bot = findBot(botId);
    if (!bot) {
      sendJson(res, 404, { error: 'Бот не найден' });
      return;
    }

    if (parts.length === 3 && req.method === 'GET') {
      sendJson(res, 200, { bot: serializeBot(bot) });
      return;
    }

    if (parts.length === 3 && req.method === 'PUT') {
      const body = await readJsonBody(req);
      if (typeof body.name !== 'undefined') {
        const name = String(body.name).trim();
        if (!name) {
          sendJson(res, 400, { error: 'Имя не может быть пустым' });
          return;
        }
        bot.name = name;
      }
      if (typeof body.token !== 'undefined') {
        const token = sanitizeToken(body.token);
        if (!token) {
          sendJson(res, 400, { error: 'Token не может быть пустым' });
          return;
        }
        bot.token = token;
      }
      if (typeof body.entryFile !== 'undefined') {
        bot.entryFile = normalizeEntryFile(body.entryFile);
      }
      if (typeof body.autostart !== 'undefined') {
        bot.autostart = Boolean(body.autostart);
      }
      bot.updatedAt = nowIso();
      appendLog(bot.id, 'Настройки бота обновлены');
      saveDb();
      sendJson(res, 200, { bot: serializeBot(bot) });
      return;
    }

    if (parts.length === 3 && req.method === 'DELETE') {
      manager.stop(bot.id);
      deleteDirectoryRecursive(botRoot(bot.id));
      db.bots = db.bots.filter((item) => item.id !== bot.id);
      saveDb();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[3] === 'start' && req.method === 'POST') {
      try {
        manager.start(bot.id);
        sendJson(res, 200, { ok: true, bot: serializeBot(bot) });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (parts[3] === 'stop' && req.method === 'POST') {
      manager.stop(bot.id);
      sendJson(res, 200, { ok: true, bot: serializeBot(bot) });
      return;
    }

    if (parts[3] === 'logs' && req.method === 'GET') {
      sendJson(res, 200, { logs: bot.logs || [] });
      return;
    }

    if (parts[3] === 'storage' && req.method === 'GET') {
      sendJson(res, 200, { storage: bot.storage || {} });
      return;
    }

    if (parts[3] === 'storage' && req.method === 'DELETE') {
      bot.storage = {};
      bot.updatedAt = nowIso();
      appendLog(bot.id, 'Постоянное хранилище очищено');
      saveDb();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[3] === 'files' && parts.length === 4 && req.method === 'GET') {
      sendJson(res, 200, { files: listFilesRecursive(botRoot(bot.id)) });
      return;
    }

    if (parts[3] === 'files' && parts[4] === 'content' && req.method === 'GET') {
      const filePath = searchParams.get('path');
      if (!filePath) {
        sendJson(res, 400, { error: 'Укажите path' });
        return;
      }
      try {
        const full = resolveBotFile(bot.id, filePath);
        if (!fs.existsSync(full)) {
          sendJson(res, 404, { error: 'Файл не найден' });
          return;
        }
        sendJson(res, 200, {
          path: normalizePathInput(filePath),
          content: fs.readFileSync(full, 'utf8')
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (parts[3] === 'files' && parts.length === 4 && req.method === 'PUT') {
      const body = await readJsonBody(req);
      try {
        const relPath = normalizePathInput(body.path);
        const full = resolveBotFile(bot.id, relPath);
        ensureDir(path.dirname(full));
        fs.writeFileSync(full, String(body.content || ''), 'utf8');
        bot.updatedAt = nowIso();
        appendLog(bot.id, `Файл сохранён: ${relPath}`);
        saveDb();
        sendJson(res, 200, { ok: true, files: listFilesRecursive(botRoot(bot.id)) });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (parts[3] === 'files' && parts[4] === 'bulk' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length) {
        sendJson(res, 400, { error: 'Нет файлов для загрузки' });
        return;
      }
      try {
        for (const file of files) {
          const relPath = normalizePathInput(file.path);
          const full = resolveBotFile(bot.id, relPath);
          ensureDir(path.dirname(full));
          fs.writeFileSync(full, String(file.content || ''), 'utf8');
        }
        bot.updatedAt = nowIso();
        appendLog(bot.id, `Загружено файлов: ${files.length}`);
        saveDb();
        sendJson(res, 200, { ok: true, files: listFilesRecursive(botRoot(bot.id)) });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (parts[3] === 'files' && parts.length === 4 && req.method === 'DELETE') {
      const filePath = searchParams.get('path');
      if (!filePath) {
        sendJson(res, 400, { error: 'Укажите path' });
        return;
      }
      try {
        const relPath = normalizePathInput(filePath);
        const full = resolveBotFile(bot.id, relPath);
        if (!fs.existsSync(full)) {
          sendJson(res, 404, { error: 'Файл не найден' });
          return;
        }
        fs.unlinkSync(full);
        bot.updatedAt = nowIso();
        appendLog(bot.id, `Файл удалён: ${relPath}`);
        saveDb();
        sendJson(res, 200, { ok: true, files: listFilesRecursive(botRoot(bot.id)) });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
  }

  sendJson(res, 404, { error: 'Маршрут не найден' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = getUrl(req);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`Telegram Bot Host running on http://localhost:${PORT}`);
});
