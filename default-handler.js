module.exports = {
  async onCommand(ctx) {
    if (ctx.command === 'start') {
      await ctx.reply(
        'Привет! Я запущен через Bot Runtime.\n' +
          'Доступные команды:\n' +
          '/start — старт\n' +
          '/help — помощь\n' +
          '/count — показать счётчик'
      );
      return;
    }

    if (ctx.command === 'help') {
      await ctx.reply(
        'Этот бот работает через long polling → router → handlers.\n' +
          'Напиши любой текст, и я отвечу.\n' +
          'Команда /count показывает, сколько сообщений ты уже отправил.'
      );
      return;
    }

    if (ctx.command === 'count') {
      const current = ctx.storage.get(`chat:${ctx.chatId}:count`) || 0;
      await ctx.reply(`У тебя сейчас ${current} сообщений.`);
      return;
    }
  },

  async onText(ctx) {
    const key = `chat:${ctx.chatId}:count`;
    const current = ctx.storage.get(key) || 0;
    ctx.storage.set(key, current + 1);

    if (ctx.text.toLowerCase() === 'ping') {
      await ctx.reply('pong');
      return;
    }

    await ctx.reply(`Ты написал: ${ctx.text}`);
  },

  async onMessage(ctx) {
    console.log('Получено сообщение от', ctx.from?.username || ctx.from?.first_name || ctx.chatId);
  }
};
