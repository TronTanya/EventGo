import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
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
    PRAGMA user_version=4;`);
  db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('installation_id',?)").run(randomUUID());
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) seed(db, directory);
  else seedProgramIfNeeded(db);
  return db;
}

function seedProgramIfNeeded(db) {
  if (db.prepare('SELECT id FROM program_items LIMIT 1').get()) return;
  if (!db.prepare("SELECT id FROM events WHERE id=1 AND title='IT-Форум 2026'").get()) return;
  insertProgram(db, 1);
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
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
