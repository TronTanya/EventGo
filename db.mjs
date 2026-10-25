import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Async DB: PostgreSQL when DATABASE_URL is set (preferred); otherwise local SQLite. */
export async function connectDatabase(directory) {
  if (process.env.DATABASE_URL) {
    const { openPostgresDatabase } = await import('./pg-adapter.mjs');
    return openPostgresDatabase(process.env.DATABASE_URL, directory);
  }
  return wrapSqlite(openDatabase(directory));
}

function wrapSqlite(raw) {
  return {
    dialect: 'sqlite',
    get: (sql, ...params) => Promise.resolve(raw.prepare(sql).get(...params)),
    all: (sql, ...params) => Promise.resolve(raw.prepare(sql).all(...params)),
    run: (sql, ...params) => Promise.resolve(raw.prepare(sql).run(...params)),
    exec: (sql) => Promise.resolve(raw.exec(sql)),
    async transaction(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try { raw.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    async backup(dest) {
      const { backup } = await import('node:sqlite');
      await backup(raw, dest);
    },
    async close() {
      raw.close();
    },
    raw
  };
}

export function openDatabase(directory) {
  mkdirSync(join(directory, 'uploads'), { recursive: true });
  const db = new DatabaseSync(join(directory, 'eventgo.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('organizer','member')));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, starts_at TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', capacity INTEGER NOT NULL CHECK(capacity>0), budget REAL NOT NULL CHECK(budget>=0), owner_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'planning', registration_open INTEGER NOT NULL DEFAULT 1, public_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS team(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'team', service TEXT NOT NULL DEFAULT '', cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', user_id INTEGER REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', assignee_id INTEGER REFERENCES team(id) ON DELETE SET NULL, due_date TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'todo', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL, category TEXT NOT NULL, planned REAL NOT NULL CHECK(planned>=0), actual REAL NOT NULL DEFAULT 0 CHECK(actual>=0));
    CREATE TABLE IF NOT EXISTS guests(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'registered', ticket TEXT NOT NULL UNIQUE, consent_at TEXT NOT NULL, checked_in_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id,email));
    CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, name TEXT NOT NULL, stored_name TEXT NOT NULL, size INTEGER NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, actor TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, client_token TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_id,user_id,client_token));
    CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_turns(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id),question TEXT NOT NULL,answer TEXT NOT NULL,model TEXT NOT NULL,use_context INTEGER NOT NULL DEFAULT 0,client_token TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(event_id,user_id,client_token));
    CREATE TABLE IF NOT EXISTS program_items(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, speaker TEXT NOT NULL DEFAULT '', hall TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS ai_turn_event_user ON ai_turns(event_id,user_id,id);
    CREATE INDEX IF NOT EXISTS chat_event_id ON chat_messages(event_id,id);
    CREATE INDEX IF NOT EXISTS task_event ON tasks(event_id);
    CREATE INDEX IF NOT EXISTS guest_event ON guests(event_id);
    CREATE INDEX IF NOT EXISTS activity_event ON activities(event_id);
    CREATE INDEX IF NOT EXISTS program_event ON program_items(event_id, starts_at, id);
    CREATE TABLE IF NOT EXISTS notification_state(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, seen_guest_id INTEGER NOT NULL DEFAULT 0, seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS surveys(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')), public_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS survey_questions(id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, text TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('rating','text','choice')), options TEXT NOT NULL DEFAULT '', required INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS survey_responses(id INTEGER PRIMARY KEY, survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL, guest_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(survey_id, guest_id));
    CREATE TABLE IF NOT EXISTS survey_answers(id INTEGER PRIMARY KEY, response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS survey_event ON surveys(event_id);
    CREATE INDEX IF NOT EXISTS survey_question ON survey_questions(survey_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS survey_response ON survey_responses(survey_id, id);
    CREATE TABLE IF NOT EXISTS registration_fields(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','choice','checkbox')), options TEXT NOT NULL DEFAULT '', required INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS guest_answers(guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE, field_id INTEGER NOT NULL REFERENCES registration_fields(id) ON DELETE CASCADE, value TEXT NOT NULL, PRIMARY KEY(guest_id, field_id));
    CREATE INDEX IF NOT EXISTS registration_field_event ON registration_fields(event_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS guest_answer_field ON guest_answers(field_id);
    CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, accepted_at TEXT, accepted_user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS invite_team ON invites(team_id);
    CREATE TABLE IF NOT EXISTS catalog_items(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('venue','contractor')), name TEXT NOT NULL, city TEXT NOT NULL, category TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 0 CHECK(capacity>=0), price REAL NOT NULL DEFAULT 0 CHECK(price>=0), price_unit TEXT NOT NULL DEFAULT 'event' CHECK(price_unit IN ('event','guest')), address TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS catalog_kind_city ON catalog_items(kind, city);
    CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, text TEXT NOT NULL, important INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS announcement_event ON announcements(event_id, id);
    CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('ticket','announcement','survey')), subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS outbox_event ON outbox(event_id, id);
    PRAGMA user_version=13;`);
  if (!db.prepare('PRAGMA table_info(expenses)').all().some(c => c.name === 'contractor_id')) {
    db.exec('ALTER TABLE expenses ADD COLUMN contractor_id INTEGER REFERENCES team(id) ON DELETE SET NULL');
    linkContractorExpenses(db);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS expense_contractor ON expenses(contractor_id) WHERE contractor_id IS NOT NULL');
  const eventColumns = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  if (!eventColumns.includes('expected_guests')) {
    db.exec('ALTER TABLE events ADD COLUMN expected_guests INTEGER NOT NULL DEFAULT 0 CHECK(expected_guests>=0)');
    seedExpectedGuests(db);
  }
  if (!eventColumns.includes('ends_at')) {
    db.exec("ALTER TABLE events ADD COLUMN ends_at TEXT NOT NULL DEFAULT ''");
    seedEndDates(db);
  }
  const outboxColumns = db.prepare('PRAGMA table_info(outbox)').all().map(c => c.name);
  if (!outboxColumns.includes('status')) {
    db.exec(`ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'demo' CHECK(status IN ('demo','pending','sent','failed'));
      ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE outbox ADD COLUMN error TEXT NOT NULL DEFAULT '';
      ALTER TABLE outbox ADD COLUMN sent_at TEXT;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, id)');
  db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('installation_id',?)").run(randomUUID());
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) seed(db, directory);
  else {seedProgramIfNeeded(db);seedSurveyIfNeeded(db);seedFormIfNeeded(db);seedPartnerIfNeeded(db);seedCatalogIfNeeded(db);seedAnnouncementsIfNeeded(db);}
  return db;
}

function seedExpectedGuests(db) {
  const set = db.prepare('UPDATE events SET expected_guests=? WHERE title=? AND expected_guests=0 AND capacity>=?');
  [['IT-Форум 2026', 160], ['Дизайн-завтрак', 30], ['Хакатон EventTech', 60]].forEach(([title, n]) => set.run(n, title, n));
}
function linkContractorExpenses(db) {
  const free = db.prepare('SELECT * FROM expenses WHERE event_id=? AND contractor_id IS NULL ORDER BY id');
  const link = db.prepare('UPDATE expenses SET contractor_id=? WHERE id=?');
  for (const c of db.prepare("SELECT * FROM team WHERE kind='contractor' AND cost>0 ORDER BY id").all()) {
    const list = free.all(c.event_id), name = c.name.toLowerCase();
    const byName = list.find(x => x.name.toLowerCase().includes(name));
    const byCost = list.filter(x => x.planned === c.cost);
    const match = byName || (byCost.length === 1 ? byCost[0] : null);
    if (match) link.run(c.id, match.id);
  }
}
function seedEndDates(db) {
  db.prepare("UPDATE events SET ends_at='2026-10-25T18:00' WHERE title='Хакатон EventTech' AND starts_at='2026-10-23T09:00' AND ends_at=''").run();
}
function seedAnnouncementsIfNeeded(db) {
  if (db.prepare('SELECT id FROM announcements LIMIT 1').get()) return;
  seedAnnouncements(db);
}
function seedAnnouncements(db) {
  if (!db.prepare("SELECT id FROM events WHERE id=1 AND title='IT-Форум 2026'").get()) return;
  db.prepare('INSERT INTO announcements(event_id,text,important,author) VALUES(1,?,0,?)')
    .run('Регистрация гостей открывается в 9:30 в холле. Возьмите с собой билет с QR-кодом — на телефоне или распечатанный.', 'Александр Войтенко');
}

function seedCatalogIfNeeded(db) {
  if (db.prepare('SELECT id FROM catalog_items LIMIT 1').get()) return;
  seedCatalog(db);
}
function seedCatalog(db) {
  const item = db.prepare('INSERT INTO catalog_items(kind,name,city,category,capacity,price,price_unit,address,description,email,phone) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  [
    ['venue','Квартал труда','Якутск','Конференц-зал',250,100000,'event','ул. Ленина, 1 (демо)','Трансформируемый зал, проектор, звук, зона кофе-брейка.','hall@kvartal.example','+7 914 000-10-01'],
    ['venue','IT-парк','Якутск','Конгресс-зал',400,150000,'event','ул. Кирова, 18 (демо)','Большой зал и три переговорные, трансляция, парковка.','events@itpark.example','+7 914 000-10-02'],
    ['venue','Креативное пространство «Север»','Якутск','Лофт',60,25000,'event','ул. Октябрьская, 5 (демо)','Камерное пространство для встреч и мастер-классов.','hello@sever.example','+7 914 000-10-03'],
    ['venue','Конгресс-холл «Полярная звезда»','Якутск','Конгресс-холл',800,320000,'event','пр. Ленина, 24 (демо)','Амфитеатр, синхронный перевод, гардероб на 800 мест.','congress@star.example','+7 914 000-10-04'],
    ['venue','Лофт «Мерзлота»','Якутск','Лофт',120,45000,'event','ул. Чернышевского, 9 (демо)','Кирпичный лофт с барной стойкой, подходит для нетворкинга.','loft@merzlota.example','+7 914 000-10-05'],
    ['venue','Дворец культуры «Горняк»','Нерюнгри','Дом культуры',300,60000,'event','пр. Дружбы народов, 7 (демо)','Сцена, звук, свет, фойе для регистрации.','dk@gornyak.example','+7 914 000-20-01'],
    ['venue','Конференц-зал гостиницы «Алмаз»','Мирный','Конференц-зал',150,50000,'event','ул. Ленина, 3 (демо)','Зал при гостинице, проживание для спикеров со скидкой.','conf@almaz.example','+7 914 000-30-01'],
    ['contractor','Северный кейтеринг','Якутск','Кейтеринг',300,1500,'guest','','Кофе-брейки, обеды и фуршеты. Вегетарианское меню по запросу.','catering@example.com','+7 914 000-40-01'],
    ['contractor','Кофе-брейк «Бодрость»','Якутск','Кейтеринг',150,600,'guest','','Кофе, чай и выпечка. Выезд в день заказа.','coffee@bodrost.example','+7 914 000-40-02'],
    ['contractor','«Звук Севера»','Якутск','Оборудование',0,60000,'event','','Звук, свет, микрофоны, техник на весь день.','rent@zvuk.example','+7 914 000-40-03'],
    ['contractor','Студия трансляций «Эфир»','Якутск','Оборудование',0,45000,'event','','Онлайн-трансляция на 2 камеры, запись выступлений.','live@efir.example','+7 914 000-40-04'],
    ['contractor','Типография «Оттиск»','Якутск','Полиграфия',0,250,'guest','','Бейджи, программки, навигация. Срок — 3 рабочих дня.','print@ottisk.example','+7 914 000-40-05'],
    ['contractor','Фотограф Ирина Степанова','Якутск','Фото и видео',0,20000,'event','','Репортажная съёмка, 150+ обработанных фото за 3 дня.','photo@stepanova.example','+7 914 000-40-06'],
    ['contractor','Агентство ведущих «Микрофон»','Якутск','Ведущие',0,30000,'event','','Ведущий форума или хакатона, сценарий открытия и закрытия.','host@mic.example','+7 914 000-40-07'],
    ['contractor','«Нерюнгри-Фуд»','Нерюнгри','Кейтеринг',200,900,'guest','','Кофе-брейки и обеды для мероприятий в Южной Якутии.','food@nerungri.example','+7 914 000-50-01'],
    ['contractor','Трансфер «Сахатранс»','Якутск','Транспорт',0,18000,'event','','Автобус на 45 мест, встреча гостей в аэропорту.','bus@sakhatrans.example','+7 914 000-40-08']
  ].forEach(row => item.run(...row));
}

function seedPartnerIfNeeded(db) {
  if (db.prepare("SELECT id FROM users WHERE email='partner@eventgo.local'").get()) return;
  db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)')
    .run('Елена Соколова', 'partner@eventgo.local', hashPassword('PartnerGo2026!'), 'organizer');
}

function seedFormIfNeeded(db) {
  if (db.prepare('SELECT id FROM registration_fields LIMIT 1').get()) return;
  seedForm(db);
}
function seedForm(db) {
  if (!db.prepare("SELECT id FROM events WHERE id=1 AND title='IT-Форум 2026'").get()) return;
  const field = db.prepare('INSERT INTO registration_fields(event_id,label,kind,options,required,sort_order) VALUES(1,?,?,?,?,?)');
  const section = Number(field.run('Какая секция вам интереснее?', 'choice', 'Технологии для города\nМастер-класс по продуктовому дизайну\nПанельная дискуссия', 1, 10).lastInsertRowid);
  const food = Number(field.run('Питание', 'choice', 'Обычное\nВегетарианское\nБез глютена', 0, 20).lastInsertRowid);
  field.run('Нужен ли раздаточный материал на английском', 'checkbox', '', 0, 30);
  const guests = db.prepare('SELECT id FROM guests WHERE event_id=1 ORDER BY id').all();
  const answer = db.prepare('INSERT OR IGNORE INTO guest_answers(guest_id,field_id,value) VALUES(?,?,?)');
  const sections = ['Технологии для города', 'Мастер-класс по продуктовому дизайну', 'Панельная дискуссия'], foods = ['Обычное', 'Обычное', 'Вегетарианское', 'Обычное', 'Без глютена'];
  guests.forEach((g, i) => { answer.run(g.id, section, sections[i % 3]); answer.run(g.id, food, foods[i % 5]); });
}

function seedProgramIfNeeded(db) {
  if (db.prepare('SELECT id FROM program_items LIMIT 1').get()) return;
  if (!db.prepare("SELECT id FROM events WHERE id=1 AND title='IT-Форум 2026'").get()) return;
  insertProgram(db, 1);
}
function seedSurveyIfNeeded(db) {
  if (db.prepare('SELECT id FROM surveys LIMIT 1').get()) return;
  seedSurveys(db);
}
function seedSurveys(db) {
  const survey = db.prepare('INSERT INTO surveys(event_id,title,description,status,public_token) VALUES(?,?,?,?,?)');
  const q = db.prepare('INSERT INTO survey_questions(survey_id,text,kind,options,required,sort_order) VALUES(?,?,?,?,?,?)');
  if (db.prepare("SELECT id FROM events WHERE id=1 AND title='IT-Форум 2026'").get()) {
    const id = Number(survey.run(1, 'Обратная связь после IT-Форума', 'Короткий опрос для гостей. Помогите сделать следующее событие лучше.', 'draft', randomBytes(16).toString('hex')).lastInsertRowid);
    q.run(id, 'Насколько вам понравилось мероприятие?', 'rating', '', 1, 10);
    q.run(id, 'Какая секция была самой полезной?', 'choice', 'Открытие\nТехнологии для города\nМастер-класс\nПанельная дискуссия\nНетворкинг', 1, 20);
    q.run(id, 'Что улучшить в следующий раз?', 'text', '', 0, 30);
  }
  if (db.prepare("SELECT id FROM events WHERE id=3 AND title='Хакатон EventTech'").get()) {
    const id = Number(survey.run(3, 'Как прошёл хакатон?', 'Оцените организацию и поделитесь впечатлениями.', 'open', randomBytes(16).toString('hex')).lastInsertRowid);
    const rating = Number(q.run(id, 'Оцените организацию хакатона', 'rating', '', 1, 10).lastInsertRowid);
    const choice = Number(q.run(id, 'Что было самым полезным?', 'choice', 'Менторы\nКейсы\nНетворкинг\nПитание и площадка', 1, 20).lastInsertRowid);
    const text = Number(q.run(id, 'Что улучшить?', 'text', '', 0, 30).lastInsertRowid);
    const response = db.prepare('INSERT INTO survey_responses(survey_id,guest_name) VALUES(?,?)');
    const answer = db.prepare('INSERT INTO survey_answers(response_id,question_id,value) VALUES(?,?,?)');
    [['Анна Иванова', '5', 'Менторы', 'Больше времени на защиту'], ['Михаил Петров', '4', 'Кейсы', ''], ['Елена Соколова', '5', 'Нетворкинг', 'Отличная атмосфера'], ['Дмитрий Андреев', '4', 'Менторы', 'Нужно больше розеток'], ['Софья Николаева', '3', 'Питание и площадка', 'Кофе закончился к вечеру']]
      .forEach(([name, r, c, t]) => {
        const rid = Number(response.run(id, name).lastInsertRowid);
        answer.run(rid, rating, r); answer.run(rid, choice, c); if (t) answer.run(rid, text, t);
      });
  }
}

function insertProgram(db, eventId) {
  const item = db.prepare('INSERT INTO program_items(event_id,starts_at,ends_at,title,speaker,hall,description,sort_order) VALUES(?,?,?,?,?,?,?,?)');
  [
    ['2026-11-18T09:30','2026-11-18T10:00','Регистрация и кофе','','Холл','Получение бейджей и знакомство с площадкой.',10],
    ['2026-11-18T10:00','2026-11-18T10:30','Открытие форума','Александр Войтенко','Главный зал','Приветствие и цели дня.',20],
    ['2026-11-18T10:30','2026-11-18T11:30','Технологии для города','Елена Соколова','Главный зал','Кейсы цифровых сервисов Якутска.',30],
    ['2026-11-18T11:45','2026-11-18T13:00','Мастер-класс: продуктовый дизайн','Диана Мирзоян','Зал А','Практика по сценариям и прототипам.',40],
    ['2026-11-18T13:00','2026-11-18T14:00','Обед и нетворкинг','','Кафе','Свободное общение участников.',50],
    ['2026-11-18T14:00','2026-11-18T15:30','Панельная дискуссия: стартапы Севера','Михаил Петров','Главный зал','Вопросы финансирования и команды.',60],
    ['2026-11-18T15:45','2026-11-18T16:30','Закрытие и планы на год','Алина Лахитова','Главный зал','Итоги и следующие встречи.',70]
  ].forEach(row => item.run(eventId, ...row));
}

function seed(db, directory) {
  db.exec('BEGIN');
  try {
    const user = db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)');
    user.run('Александр Войтенко', 'organizer@eventgo.local', hashPassword('EventGo2026!'), 'organizer');
    user.run('Диана Мирзоян', 'team@eventgo.local', hashPassword('TeamGo2026!'), 'member');
    user.run('Елена Соколова', 'partner@eventgo.local', hashPassword('PartnerGo2026!'), 'organizer');
    const event = db.prepare('INSERT INTO events(title,type,starts_at,location,description,goal,capacity,budget,owner_id,status,public_token) VALUES(?,?,?,?,?,?,?,?,1,?,?)');
    event.run('IT-Форум 2026', 'Форум', '2026-11-18T10:00', 'Якутск, Квартал труда', 'Технологии, люди и идеи, которые меняют город. День полезных знакомств, дискуссий и практических мастер-классов для IT-сообщества Якутска.', 'Объединить IT-сообщество и запустить новые совместные проекты.', 200, 350000, 'planning', randomBytes(16).toString('hex'));
    event.run('Дизайн-завтрак', 'Встреча', '2026-11-07T11:00', 'Якутск, креативное пространство', 'Неформальная встреча дизайнеров: обмен опытом, разбор портфолио и новые знакомства.', 'Познакомить локальных дизайнеров.', 40, 45000, 'planning', randomBytes(16).toString('hex'));
    event.run('Хакатон EventTech', 'Хакатон', '2026-10-23T09:00', 'Якутск, IT-парк', 'Три дня работы над цифровыми сервисами для организаторов мероприятий.', 'Создать работающие прототипы.', 80, 180000, 'active', randomBytes(16).toString('hex'));
    const member = db.prepare('INSERT INTO team(event_id,name,role,email,phone,kind,service,cost,user_id) VALUES(?,?,?,?,?,?,?,?,?)');
    for (let id = 1; id <= 3; id++) {
      member.run(id, 'Александр Войтенко', 'Организатор', 'organizer@eventgo.local', '', 'team', '', 0, 1);
      member.run(id, 'Диана Мирзоян', 'Дизайнер', 'team@eventgo.local', '', 'team', '', 0, 2);
      member.run(id, 'Алина Лахитова', 'Координатор', 'alina@example.com', '', 'team', '', 0, null);
      member.run(id, 'Наина Портнягина', 'UX-дизайнер', 'naina@example.com', '', 'team', '', 0, null);
    }
    member.run(1, 'Северный кейтеринг', 'Менеджер', 'catering@example.com', '', 'contractor', 'Кофе-брейки и обед', 75000, null);
    const task = db.prepare('INSERT INTO tasks(event_id,title,description,assignee_id,due_date,priority,status) VALUES(?,?,?,?,?,?,?)');
    [
      ['Согласовать площадку','Проверить вместимость, оборудование и условия аренды.',1,'2026-10-22','high','progress'],
      ['Подготовить афишу','Адаптировать фирменный стиль для социальных сетей и печати.',2,'2026-11-02','high','progress'],
      ['Утвердить программу форума','Собрать выступления спикеров и расписание секций.',3,'2026-11-05','high','progress'],
      ['Открыть регистрацию гостей','Проверить форму и разместить ссылку на странице мероприятия.',1,'2026-11-01','normal','done'],
      ['Заказать бейджи и полиграфию','Подготовить макеты и согласовать тираж.',2,'2026-11-10','normal','todo'],
      ['Согласовать меню кофе-брейка','Уточнить число порций и ограничения по питанию.',13,'2026-11-12','normal','todo'],
      ['Составить список спикеров','Подтвердить темы и контактные данные.',3,'2026-10-20','normal','done'],
      ['Разработать визуальный стиль','Логотип, цвета и шаблоны для команды.',2,'2026-10-21','normal','done'],
      ['Проверить оборудование','Микрофоны, звук, проектор и трансляция.',1,'2026-11-17','high','todo'],
      ['Подготовить навигацию','Указатели залов и стойки регистрации.',4,'2026-11-14','low','todo'],
      ['Найти волонтёров','Собрать команду из 10 волонтёров.',3,'2026-11-08','normal','done'],
      ['Собрать партнёрские предложения','Подготовить пакет для партнёров.',1,'2026-10-23','normal','done']
    ].forEach(t => task.run(1,...t));
    task.run(2,'Выбрать тему встречи','Собрать предложения от сообщества.',7,'2026-11-01','normal','todo');
    task.run(3,'Подготовить защиту проекта','Проверить демонстрационный сценарий.',9,'2026-10-25','high','progress');
    db.prepare('INSERT INTO comments(task_id,user_id,text) VALUES(2,2,?)').run('Первый вариант афиши готов. Сегодня согласуем композицию и цвета.');
    const expense = db.prepare('INSERT INTO expenses(event_id,name,category,planned,actual) VALUES(?,?,?,?,?)');
    [['Аренда площадки','Площадка',120000,100000],['Кофе-брейк и обед','Кейтеринг',75000,45000],['Звук и трансляция','Оборудование',60000,42000],['Бейджи и оформление','Полиграфия',35000,12000],['Продвижение события','Реклама',40000,18000]].forEach(e=>expense.run(1,...e));
    expense.run(2,'Кофе и завтрак','Кейтеринг',30000,15000);
    expense.run(3,'Призы участникам','Призы',80000,65000);
    const guest = db.prepare('INSERT INTO guests(event_id,name,email,company,status,ticket,consent_at,checked_in_at) VALUES(?,?,?,?,?,?,?,?)');
    const names=['Анна Иванова','Михаил Петров','Елена Соколова','Дмитрий Андреев','Софья Николаева','Артём Фёдоров','Мария Васильева','Иван Алексеев','Дарья Попова','Никита Павлов','Алиса Егорова','Сергей Михайлов'];
    const companies=['СВФУ','IT-парк','Студия «Север»','Квартал труда'];
    for(let i=0;i<48;i++) guest.run(1, names[i%12]+(i>=12?` ${i+1}`:''),`guest${i+1}@example.com`,companies[i%4],i<34?'confirmed':'registered',randomBytes(16).toString('hex'),new Date().toISOString(),null);
    for(let i=0;i<8;i++) guest.run(3,names[i],`hack${i+1}@example.com`,'Команда хакатона',i<5?'attended':'confirmed',randomBytes(16).toString('hex'),new Date().toISOString(),i<5?new Date().toISOString():null);
    const activity = db.prepare('INSERT INTO activities(event_id,actor,text) VALUES(?,?,?)');
    activity.run(1,'Диана','добавила комментарий к задаче «Подготовить афишу»');
    activity.run(1,'Алина','подтвердила участие гостей');
    activity.run(1,'Александр','открыл регистрацию на IT-Форум 2026');
    const samples=[['Бриф мероприятия.txt','Цель IT-Форума 2026 — объединить IT-сообщество Якутска.\nДата: 18 ноября 2026, 10:00.\nПлощадка: Квартал труда.\nПлан: 200 участников.\nЭто демонстрационный документ.\n',null],['Задачи дизайнера.txt','Подготовить афишу IT-Форума 2026.\nИспользовать фирменные цвета #7C5CFF, #FF762B и #CCFA56.\nСогласовать макет с организатором.\nЭто демонстрационный документ.\n',2]];
    for(const [name,text,taskId] of samples){const stored=randomBytes(24).toString('hex');const bytes=Buffer.from(text);writeFileSync(join(directory,'uploads',stored),bytes);db.prepare('INSERT INTO files(event_id,task_id,name,stored_name,size,created_by) VALUES(1,?,?,?,?,1)').run(taskId,name,stored,bytes.length);}
    insertProgram(db, 1);
    db.prepare('INSERT INTO program_items(event_id,starts_at,ends_at,title,speaker,hall,description,sort_order) VALUES(?,?,?,?,?,?,?,?)')
      .run(3, '2026-10-25T14:00', '2026-10-25T16:00', 'Защита проектов', 'Жюри хакатона', 'Актовый зал', 'Презентации команд и вопросы жюри.', 10);
    seedSurveys(db);
    seedForm(db);
    seedCatalog(db);
    seedAnnouncements(db);
    seedExpectedGuests(db);
    seedEndDates(db);
    linkContractorExpenses(db);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
