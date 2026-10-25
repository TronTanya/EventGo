/** Готовые планы подготовки: сроки задач — дней до начала мероприятия (отрицательные = до старта). */

const TEMPLATES = [
  {
    id: 'forum',
    name: 'Форум / конференция',
    type: 'Форум',
    description: 'Задачи и типовой бюджет для делового форума или конференции на 1–2 дня.',
    capacity: 200,
    budget: 450000,
    tasks: [
      { title: 'Утвердить концепцию и программу', description: 'Тема, треки, ключевые спикеры', days: -45, priority: 'high' },
      { title: 'Забронировать площадку', description: 'Договор, аванс, техтребования', days: -40, priority: 'high' },
      { title: 'Собрать оргкомитет и роли', description: 'Ответственные за программу, логистику, PR', days: -35, priority: 'normal' },
      { title: 'Пригласить спикеров', description: 'Письма, подтверждения, брифы', days: -30, priority: 'high' },
      { title: 'Открыть регистрацию гостей', description: 'Форма, афиша, рассылка партнёрам', days: -25, priority: 'high' },
      { title: 'Заказать кейтеринг и оборудование', description: 'Меню, звук, экран, Wi‑Fi', days: -18, priority: 'normal' },
      { title: 'Подготовить полиграфию и бейджи', description: 'Бейджи, указатели, программа', days: -10, priority: 'normal' },
      { title: 'Финальный чек-лист площадки', description: 'Рассадка, тайминг, репетиция входа', days: -2, priority: 'high' },
      { title: 'Собрать обратную связь', description: 'Опрос гостей и отчёт', days: 1, priority: 'normal' }
    ],
    expenses: [
      { name: 'Аренда зала', category: 'Площадка', planned: 180000 },
      { name: 'Кейтеринг и кофе-брейки', category: 'Кейтеринг', planned: 90000 },
      { name: 'Звук и экран', category: 'Оборудование', planned: 45000 },
      { name: 'Полиграфия и бейджи', category: 'Полиграфия', planned: 25000 },
      { name: 'Реклама и рассылки', category: 'Реклама', planned: 35000 },
      { name: 'Фото и видео', category: 'Подрядчики', planned: 40000 }
    ]
  },
  {
    id: 'hackathon',
    name: 'Хакатон',
    type: 'Хакатон',
    description: 'Подготовка соревнования команд: площадка, призы, жюри и техподдержка.',
    capacity: 120,
    budget: 280000,
    tasks: [
      { title: 'Сформулировать задания и критерии', description: 'Трек, данные, правила оценки', days: -30, priority: 'high' },
      { title: 'Найти площадку и питание', description: 'Розетки, интернет, ночной доступ', days: -25, priority: 'high' },
      { title: 'Собрать жюри и менторов', description: 'Подтверждения и расписание ревью', days: -20, priority: 'high' },
      { title: 'Открыть регистрацию команд', description: 'Форма, лимиты, чек-лист участника', days: -18, priority: 'high' },
      { title: 'Закупить призы и мерч', description: 'Кубки, сертификаты, подарки', days: -12, priority: 'normal' },
      { title: 'Подготовить инфраструктуру', description: 'Wi‑Fi, розетки, Discord/чат, таймер', days: -5, priority: 'high' },
      { title: 'Брифинг волонтёров', description: 'Регистрация, помощь командам', days: -1, priority: 'normal' },
      { title: 'Награждение и публикация результатов', description: 'Итоги, фото, посты', days: 1, priority: 'normal' }
    ],
    expenses: [
      { name: 'Аренда коворкинга / зала', category: 'Площадка', planned: 80000 },
      { name: 'Питание участников', category: 'Кейтеринг', planned: 70000 },
      { name: 'Призы и мерч', category: 'Призы', planned: 60000 },
      { name: 'Интернет и техника', category: 'Оборудование', planned: 25000 },
      { name: 'Полиграфия', category: 'Полиграфия', planned: 15000 },
      { name: 'Реклама набора', category: 'Реклама', planned: 20000 }
    ]
  },
  {
    id: 'corporate',
    name: 'Корпоративное событие',
    type: 'Корпоративное событие',
    description: 'Внутреннее мероприятие компании: площадка, подрядчики и программа вечера.',
    capacity: 80,
    budget: 320000,
    tasks: [
      { title: 'Согласовать формат и бюджет с руководством', description: 'Дата, число гостей, сценарий', days: -35, priority: 'high' },
      { title: 'Выбрать площадку и меню', description: 'Договор и предоплата', days: -28, priority: 'high' },
      { title: 'Нанять ведущего / артистов', description: 'Техридер и тайминг', days: -21, priority: 'normal' },
      { title: 'Собрать список гостей и рассылку', description: 'Приглашения и RSVP', days: -18, priority: 'high' },
      { title: 'Оформить зал и фотозону', description: 'Декор, брендинг, свет', days: -10, priority: 'normal' },
      { title: 'Проверить логистику и вход', description: 'Трансфер, гардероб, бейджи', days: -3, priority: 'high' },
      { title: 'Собрать отзывы и отчёт', description: 'Фото, расходы, NPS', days: 2, priority: 'normal' }
    ],
    expenses: [
      { name: 'Аренда площадки', category: 'Площадка', planned: 120000 },
      { name: 'Банкет / фуршет', category: 'Кейтеринг', planned: 100000 },
      { name: 'Ведущий и артисты', category: 'Подрядчики', planned: 50000 },
      { name: 'Декор и фотозона', category: 'Полиграфия', planned: 25000 },
      { name: 'Транспорт', category: 'Транспорт', planned: 15000 },
      { name: 'Фотограф', category: 'Подрядчики', planned: 20000 }
    ]
  },
  {
    id: 'meetup',
    name: 'Встреча / митап',
    type: 'Встреча',
    description: 'Короткий план для небольшой встречи или митапа.',
    capacity: 40,
    budget: 45000,
    tasks: [
      { title: 'Найти площадку или ссылку на созвон', description: 'Вместимость и техника', days: -14, priority: 'high' },
      { title: 'Пригласить спикера', description: 'Тема, тайминг, материалы', days: -12, priority: 'high' },
      { title: 'Открыть регистрацию', description: 'Форма и анонс', days: -10, priority: 'normal' },
      { title: 'Подготовить чай / перекус', description: 'Если офлайн', days: -3, priority: 'low' },
      { title: 'Напомнить гостям за день', description: 'Письмо или объявление', days: -1, priority: 'normal' },
      { title: 'Собрать короткую обратную связь', description: 'Оценка и идеи', days: 1, priority: 'low' }
    ],
    expenses: [
      { name: 'Аренда зала / коворкинг', category: 'Площадка', planned: 15000 },
      { name: 'Чай и перекус', category: 'Кейтеринг', planned: 12000 },
      { name: 'Полиграфия', category: 'Полиграфия', planned: 5000 },
      { name: 'Реклама анонса', category: 'Реклама', planned: 8000 }
    ]
  }
];

export function listTemplates() {
  return TEMPLATES.map(({ id, name, type, description, capacity, budget, tasks, expenses }) => ({
    id, name, type, description, capacity, budget,
    tasks: tasks.length, expenses: expenses.length
  }));
}

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

export function dueDateFromStart(startsAt, daysOffset) {
  const day = startsAt.slice(0, 10);
  const base = Date.parse(day + 'T12:00:00+09:00');
  if (!Number.isFinite(base)) throw Object.assign(new Error('Некорректная дата мероприятия.'), { status: 400 });
  return new Date(base + daysOffset * 86400000).toISOString().slice(0, 10);
}

/** Нормализует план из шаблона или от ИИ: задачи со сдвигом в днях, статьи с плановой суммой. */
export function normalizePlan(input, categories) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object') fail('Передайте план подготовки.');
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const expenses = Array.isArray(input.expenses) ? input.expenses : [];
  if (!tasks.length && !expenses.length) fail('В плане нет задач и статей бюджета.');
  if (tasks.length > 40 || expenses.length > 30) fail('План слишком большой: до 40 задач и 30 статей бюджета.');
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  return {
    tasks: tasks.map(t => {
      const title = text(t?.title, 200);
      if (!title) fail('У каждой задачи должно быть название.');
      const days = Math.round(Number(t.days ?? t.days_before ?? 0));
      return {
        title,
        description: text(t.description, 1000),
        days: Number.isFinite(days) ? Math.max(-365, Math.min(30, days)) : 0,
        priority: ['low', 'normal', 'high'].includes(t.priority) ? t.priority : 'normal'
      };
    }),
    expenses: expenses.map(x => {
      const name = text(x?.name, 200);
      if (!name) fail('У каждой статьи бюджета должно быть название.');
      const planned = Math.round(Number(x.planned) || 0);
      return {
        name,
        category: categories.includes(x.category) ? x.category : 'Другое',
        planned: Math.max(0, Math.min(1e10, planned))
      };
    })
  };
}

export function templatePlan(template, eventBudget) {
  const scale = eventBudget > 0 && template.budget > 0 ? eventBudget / template.budget : 1;
  return {
    tasks: template.tasks.map(t => ({ ...t })),
    expenses: template.expenses.map(x => ({ ...x, planned: Math.round(x.planned * scale / 1000) * 1000 }))
  };
}
