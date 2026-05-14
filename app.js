const state = {
  bots: [],
  selectedBotId: localStorage.getItem('selectedBotId') || '',
  selectedBot: null,
  currentFile: '',
  logsTimer: null,
  botsTimer: null
};

const els = {
  serviceStatus: document.getElementById('service-status'),
  serviceUrl: document.getElementById('service-url'),
  createForm: document.getElementById('create-form'),
  newName: document.getElementById('new-name'),
  newToken: document.getElementById('new-token'),
  newEntry: document.getElementById('new-entry'),
  newAutostart: document.getElementById('new-autostart'),
  botList: document.getElementById('bot-list'),
  refreshBots: document.getElementById('refresh-bots'),
  selectedTitle: document.getElementById('selected-title'),
  botMeta: document.getElementById('bot-meta'),
  startBot: document.getElementById('start-bot'),
  stopBot: document.getElementById('stop-bot'),
  deleteBot: document.getElementById('delete-bot'),
  newFile: document.getElementById('new-file'),
  uploadFiles: document.getElementById('upload-files'),
  uploadFolder: document.getElementById('upload-folder'),
  fileList: document.getElementById('file-list'),
  editorTitle: document.getElementById('editor-title'),
  codeEditor: document.getElementById('code-editor'),
  saveFile: document.getElementById('save-file'),
  deleteFile: document.getElementById('delete-file'),
  editName: document.getElementById('edit-name'),
  editToken: document.getElementById('edit-token'),
  editEntry: document.getElementById('edit-entry'),
  editAutostart: document.getElementById('edit-autostart'),
  saveSettings: document.getElementById('save-settings'),
  refreshLogs: document.getElementById('refresh-logs'),
  clearStorage: document.getElementById('clear-storage'),
  logs: document.getElementById('logs')
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof data === 'object' && data?.error ? data.error : response.statusText;
    throw new Error(message);
  }
  return data;
}

function toast(message) {
  window.alert(message);
}

function setServiceStatus(ok) {
  els.serviceStatus.textContent = ok ? 'онлайн' : 'ошибка';
  els.serviceUrl.textContent = window.location.origin;
}

function selectedBotSummary() {
  return state.bots.find((bot) => bot.id === state.selectedBotId) || null;
}

function syncActionButtons() {
  const bot = state.selectedBot;
  const hasBot = Boolean(bot);
  els.startBot.disabled = !hasBot;
  els.stopBot.disabled = !hasBot;
  els.deleteBot.disabled = !hasBot;
  els.newFile.disabled = !hasBot;
  els.saveFile.disabled = !hasBot || !state.currentFile;
  els.deleteFile.disabled = !hasBot || !state.currentFile;
  els.saveSettings.disabled = !hasBot;
  els.refreshLogs.disabled = !hasBot;
  els.clearStorage.disabled = !hasBot;
  els.editName.disabled = !hasBot;
  els.editToken.disabled = !hasBot;
  els.editEntry.disabled = !hasBot;
  els.editAutostart.disabled = !hasBot;
  els.codeEditor.disabled = !hasBot || !state.currentFile;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderBotList() {
  if (!state.bots.length) {
    els.botList.className = 'bot-list empty';
    els.botList.textContent = 'Пока нет ботов';
    return;
  }

  els.botList.className = 'bot-list';
  els.botList.innerHTML = state.bots
    .map((bot) => {
      const active = bot.id === state.selectedBotId ? 'active' : '';
      return `
        <button class="bot-card ${active}" data-bot-id="${bot.id}">
          <strong>${escapeHtml(bot.name)}</strong>
          <div class="small">${bot.running ? '● Запущен' : '○ Остановлен'}</div>
          <div class="small">Entry: ${escapeHtml(bot.entryFile || 'bot.js')}</div>
          <div class="small">Файлов: ${bot.files?.length || 0} / Storage: ${bot.storageKeys || 0}</div>
        </button>
      `;
    })
    .join('');

  for (const button of els.botList.querySelectorAll('[data-bot-id]')) {
    button.addEventListener('click', () => selectBot(button.dataset.botId));
  }
}

function renderMeta(bot) {
  els.selectedTitle.textContent = bot.name;
  els.botMeta.className = 'meta-grid';
  els.botMeta.innerHTML = `
    <div class="meta-box"><span>ID</span><strong>${escapeHtml(bot.id)}</strong></div>
    <div class="meta-box"><span>Token</span><strong>${escapeHtml(bot.maskedToken || '—')}</strong></div>
    <div class="meta-box"><span>Статус</span><strong>${bot.running ? 'Запущен' : 'Остановлен'}</strong></div>
    <div class="meta-box"><span>Entry file</span><strong>${escapeHtml(bot.entryFile || 'bot.js')}</strong></div>
    <div class="meta-box"><span>Автозапуск</span><strong>${bot.autostart ? 'Да' : 'Нет'}</strong></div>
    <div class="meta-box"><span>Storage keys</span><strong>${bot.storageKeys || 0}</strong></div>
  `;

  els.editName.value = bot.name || '';
  els.editToken.value = '';
  els.editEntry.value = bot.entryFile || 'bot.js';
  els.editAutostart.checked = Boolean(bot.autostart);
}

function renderFiles(bot) {
  if (!bot) {
    els.fileList.className = 'file-list empty';
    els.fileList.textContent = 'Нет выбранного бота';
    return;
  }

  const files = bot.files || [];
  if (!files.length) {
    els.fileList.className = 'file-list empty';
    els.fileList.textContent = 'Файлов ещё нет';
    return;
  }

  if (state.currentFile && !files.some((file) => file.path === state.currentFile)) {
    state.currentFile = '';
    els.codeEditor.value = '';
  }

  els.fileList.className = 'file-list';
  els.fileList.innerHTML = files
    .map((file) => {
      const active = file.path === state.currentFile ? 'active' : '';
      return `
        <button class="file-item ${active}" data-file-path="${escapeHtml(file.path)}">
          <strong>${escapeHtml(file.path)}</strong>
          <div class="small">${file.size} bytes</div>
        </button>
      `;
    })
    .join('');

  for (const button of els.fileList.querySelectorAll('[data-file-path]')) {
    button.addEventListener('click', () => loadFile(button.dataset.filePath));
  }
}

function renderLogs(bot) {
  if (!bot) {
    els.logs.className = 'logs empty';
    els.logs.textContent = 'Нет выбранного бота';
    return;
  }

  const logs = bot.logs || [];
  if (!logs.length) {
    els.logs.className = 'logs empty';
    els.logs.textContent = 'Логи пустые';
    return;
  }

  els.logs.className = 'logs';
  els.logs.textContent = logs.map((item) => `[${item.at}] ${item.message}`).join('\n');
  els.logs.scrollTop = els.logs.scrollHeight;
}

function clearEditor() {
  els.editorTitle.textContent = 'Редактор';
  els.codeEditor.value = '';
  state.currentFile = '';
}

async function refreshBots(keepSelection = true) {
  const data = await api('/api/bots');
  state.bots = data.bots || [];

  if (!keepSelection) {
    state.selectedBotId = state.bots[0]?.id || '';
  }

  if (state.selectedBotId && !state.bots.some((bot) => bot.id === state.selectedBotId)) {
    state.selectedBotId = state.bots[0]?.id || '';
  }

  if (!state.selectedBotId && state.bots[0]) {
    state.selectedBotId = state.bots[0].id;
  }

  localStorage.setItem('selectedBotId', state.selectedBotId || '');
  renderBotList();

  if (state.selectedBotId) {
    await loadBot(state.selectedBotId, false);
  } else {
    state.selectedBot = null;
    clearEditor();
    els.selectedTitle.textContent = 'Выбери бота';
    els.botMeta.className = 'meta-grid placeholder-card';
    els.botMeta.textContent = 'Слева создай бота или выбери существующего.';
    renderFiles(null);
    renderLogs(null);
    syncActionButtons();
  }
}

async function loadBot(botId, resetFileIfNeeded = true) {
  const data = await api(`/api/bots/${botId}`);
  state.selectedBot = data.bot;
  state.selectedBotId = data.bot.id;
  localStorage.setItem('selectedBotId', state.selectedBotId);
  renderBotList();
  renderMeta(data.bot);
  renderFiles(data.bot);
  renderLogs(data.bot);
  syncActionButtons();

  if (resetFileIfNeeded && !state.currentFile) {
    const preferred = data.bot.files?.find((item) => item.path === data.bot.entryFile)?.path || data.bot.files?.[0]?.path;
    if (preferred) {
      await loadFile(preferred);
    }
  } else if (state.currentFile) {
    const stillExists = data.bot.files?.find((item) => item.path === state.currentFile);
    if (!stillExists) {
      clearEditor();
      syncActionButtons();
    }
  }
}

async function selectBot(botId) {
  state.currentFile = '';
  els.codeEditor.value = '';
  await loadBot(botId, true);
}

async function loadFile(filePath) {
  if (!state.selectedBotId) return;
  const data = await api(`/api/bots/${state.selectedBotId}/files/content?path=${encodeURIComponent(filePath)}`);
  state.currentFile = data.path;
  els.editorTitle.textContent = `Редактор — ${data.path}`;
  els.codeEditor.value = data.content || '';
  renderFiles(state.selectedBot);
  syncActionButtons();
}

async function saveCurrentFile() {
  if (!state.selectedBotId || !state.currentFile) return;
  await api(`/api/bots/${state.selectedBotId}/files`, {
    method: 'PUT',
    body: JSON.stringify({
      path: state.currentFile,
      content: els.codeEditor.value
    })
  });
  await loadBot(state.selectedBotId, false);
  toast('Файл сохранён');
}

async function deleteCurrentFile() {
  if (!state.selectedBotId || !state.currentFile) return;
  if (!confirm(`Удалить файл ${state.currentFile}?`)) return;
  await api(`/api/bots/${state.selectedBotId}/files?path=${encodeURIComponent(state.currentFile)}`, {
    method: 'DELETE'
  });
  clearEditor();
  await loadBot(state.selectedBotId, false);
}

function normalizeUploadedPath(file) {
  const raw = file.webkitRelativePath || file.name;
  const normalized = raw.replaceAll('\\', '/');
  if (file.webkitRelativePath) {
    const parts = normalized.split('/');
    return parts.slice(1).join('/') || file.name;
  }
  return normalized;
}

async function readFilesForUpload(fileList) {
  const files = [];
  for (const file of fileList) {
    const text = await file.text();
    files.push({
      path: normalizeUploadedPath(file),
      content: text
    });
  }
  return files;
}

async function uploadMany(fileList) {
  if (!state.selectedBotId) return;
  if (!fileList.length) return;
  const files = await readFilesForUpload(fileList);
  await api(`/api/bots/${state.selectedBotId}/files/bulk`, {
    method: 'POST',
    body: JSON.stringify({ files })
  });
  await loadBot(state.selectedBotId, false);
  toast(`Загружено ${files.length} файл(ов)`);
}

async function startBot() {
  await api(`/api/bots/${state.selectedBotId}/start`, { method: 'POST' });
  await refreshBots(true);
}

async function stopBot() {
  await api(`/api/bots/${state.selectedBotId}/stop`, { method: 'POST' });
  await refreshBots(true);
}

async function deleteBot() {
  if (!state.selectedBotId) return;
  if (!confirm('Удалить бота целиком вместе со всеми файлами?')) return;
  await api(`/api/bots/${state.selectedBotId}`, { method: 'DELETE' });
  state.selectedBotId = '';
  state.selectedBot = null;
  clearEditor();
  await refreshBots(true);
}

async function saveSettings() {
  if (!state.selectedBotId) return;
  const payload = {
    name: els.editName.value.trim(),
    entryFile: els.editEntry.value.trim() || 'bot.js',
    autostart: els.editAutostart.checked
  };
  if (els.editToken.value.trim()) {
    payload.token = els.editToken.value.trim();
  }
  await api(`/api/bots/${state.selectedBotId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  els.editToken.value = '';
  await refreshBots(true);
  toast('Настройки сохранены');
}

async function refreshLogs() {
  if (!state.selectedBotId) return;
  const data = await api(`/api/bots/${state.selectedBotId}/logs`);
  if (state.selectedBot) {
    state.selectedBot.logs = data.logs || [];
    renderLogs(state.selectedBot);
  }
}

async function clearStorage() {
  if (!state.selectedBotId) return;
  if (!confirm('Очистить постоянное storage этого бота?')) return;
  await api(`/api/bots/${state.selectedBotId}/storage`, { method: 'DELETE' });
  await refreshBots(true);
}

function bindEvents() {
  els.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/bots', {
        method: 'POST',
        body: JSON.stringify({
          name: els.newName.value.trim(),
          token: els.newToken.value.trim(),
          entryFile: els.newEntry.value.trim() || 'bot.js',
          autostart: els.newAutostart.checked
        })
      });
      els.createForm.reset();
      els.newEntry.value = 'bot.js';
      els.newAutostart.checked = true;
      await refreshBots(false);
    } catch (error) {
      toast(error.message);
    }
  });

  els.refreshBots.addEventListener('click', () => refreshBots(true).catch((error) => toast(error.message)));
  els.startBot.addEventListener('click', () => startBot().catch((error) => toast(error.message)));
  els.stopBot.addEventListener('click', () => stopBot().catch((error) => toast(error.message)));
  els.deleteBot.addEventListener('click', () => deleteBot().catch((error) => toast(error.message)));
  els.saveFile.addEventListener('click', () => saveCurrentFile().catch((error) => toast(error.message)));
  els.deleteFile.addEventListener('click', () => deleteCurrentFile().catch((error) => toast(error.message)));
  els.saveSettings.addEventListener('click', () => saveSettings().catch((error) => toast(error.message)));
  els.refreshLogs.addEventListener('click', () => refreshLogs().catch((error) => toast(error.message)));
  els.clearStorage.addEventListener('click', () => clearStorage().catch((error) => toast(error.message)));

  els.newFile.addEventListener('click', async () => {
    if (!state.selectedBotId) return;
    const filePath = prompt('Новый файл, например utils/helper.js', 'bot.js');
    if (!filePath) return;
    try {
      state.currentFile = filePath;
      els.codeEditor.value = '// Новый файл\n';
      await saveCurrentFile();
      await loadFile(filePath);
    } catch (error) {
      toast(error.message);
    }
  });

  els.uploadFiles.addEventListener('change', async () => {
    try {
      await uploadMany(Array.from(els.uploadFiles.files || []));
      els.uploadFiles.value = '';
    } catch (error) {
      toast(error.message);
    }
  });

  els.uploadFolder.addEventListener('change', async () => {
    try {
      await uploadMany(Array.from(els.uploadFolder.files || []));
      els.uploadFolder.value = '';
    } catch (error) {
      toast(error.message);
    }
  });
}

async function init() {
  bindEvents();
  try {
    await api('/api/health');
    setServiceStatus(true);
  } catch (_) {
    setServiceStatus(false);
  }
  await refreshBots(true);
  state.logsTimer = setInterval(() => refreshLogs().catch(() => {}), 4000);
  state.botsTimer = setInterval(() => refreshBots(true).catch(() => {}), 8000);
}

syncActionButtons();
init().catch((error) => {
  console.error(error);
  toast(error.message || 'Ошибка инициализации');
});
