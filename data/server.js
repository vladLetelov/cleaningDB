import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import { Readable } from "stream";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import PDFDocument from 'pdfkit';

// Получаем текущий путь к файлу
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Создаем пул подключений к базе данных
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  ssl: { rejectUnauthorized: false } // Для db4free
});

// Проверка подключения к БД при старте
db.getConnection()
  .then((conn) => {
    console.log("Подключено к базе данных MySQL");
    conn.release();
  })
  .catch((err) => {
    console.error("Ошибка подключения к БД:", err);
  });

// Получение услуг
app.get("/api/services", async (req, res) => {
  try {
    const [services] = await db.query("SELECT * FROM Услуги");
    res.json(services);
  } catch (error) {
    console.error("Ошибка при получении услуг:", error);
    res.status(500).json({ error: "Не удалось получить услуги" });
  }
});

// Функция для генерации PDF
async function generatePDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const buffers = []; // Здесь будем накапливать данные PDF
    
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    
    // Установка шрифта
    doc.font(join(__dirname, 'fonts', 'Roboto-Bold.ttf'));

    // Формирование PDF
    doc.fontSize(20).text('Химчистка "Белоснежка"', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(14).text('Чек заявки', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Дата создания: ${new Date(data.creationDate).toLocaleString('ru-RU')}`);
    doc.text(`Дата возврата: ${new Date(data.returnDate).toLocaleString('ru-RU')}`);
    doc.text(`Телефон: ${data.phone}`);
    doc.moveDown();
    
    doc.fontSize(14).text('Выбранные услуги:');
    data.services.forEach(service => {
      doc.text(`- ${service.Наименование}: ${service.Цена} руб.`);
    });
    doc.moveDown();
    
    doc.fontSize(16).text(`Итого: ${data.totalPrice} руб.`, { align: 'right' });
    doc.moveDown();
    
    doc.fontSize(12).text('Спасибо за ваш заказ!', { align: 'center' });
    doc.fontSize(12).text('Связь с нами @wladgraft', { align: 'center' });
    
    doc.end();
  });
}

// Создание заявки
app.post("/api/requests", async (req, res) => {
  try {
    const { userId, phone, services, totalPrice } = req.body;
    
    // Форматируем даты
    const creationDate = new Date().toISOString();
    const returnDate = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Генерируем PDF в память (без сохранения на диск)
    const pdfBuffer = await generatePDF({
      creationDate,
      returnDate,
      phone,
      services,
      totalPrice,
    });

    // Сохраняем заявку в БД
    await db.query(
      `INSERT INTO Заявки 
       (ID_Пользователя, Телефон, Цена, ДатаПриема, ДатаВозврата, ВыбранныеУслуги)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        phone,
        totalPrice,
        creationDate.replace("T", " ").replace(/\..+/, ""),
        returnDate.replace("T", " ").replace(/\..+/, ""),
        JSON.stringify(services),
      ]
    );

    // Формируем имя файла с датой
    const filename = `заявка_${new Date().toISOString().slice(0, 10).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

    // Кодируем имя файла для безопасной передачи в заголовках
    const encodedFilename = encodeURIComponent(filename);

    // Устанавливаем заголовки для скачивания
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${encodedFilename}"`);

    // Отправка файла
    const pdfStream = new Readable();
    pdfStream.push(pdfBuffer);
    pdfStream.push(null); // Закрытие потока
    pdfStream.pipe(res); // Отправка PDF через поток
  } catch (error) {
    console.error("Ошибка при отправке PDF:", error);
    res.status(500).send("Ошибка на сервере");
  }
});

// Получение всех заявок с учетом скидки
app.get("/api/admin/requests", async (req, res) => {
  try {
    // Сначала получаем количество заявок для каждого пользователя
    const [userRequestCounts] = await db.query(`
      SELECT 
        ID_Пользователя,
        COUNT(*) as request_count
      FROM Заявки
      GROUP BY ID_Пользователя
    `);

    const discountUsers = userRequestCounts
      .filter((u) => u.request_count >= 3)
      .map((u) => u.ID_Пользователя);

    // Затем получаем все заявки с учетом скидки
    const [requests] = await db.query(`
      SELECT 
        з.ID,
        з.Телефон,
        з.Цена,
        з.ДатаПриема,
        з.Статус,
        з.ВыбранныеУслуги,
        п.Логин AS Пользователь,
        п.ID AS ID_Пользователя
      FROM Заявки з
      JOIN Пользователи п ON з.ID_Пользователя = п.ID
      ORDER BY з.ДатаПриема DESC
    `);

    const formattedRequests = requests.map((r) => {
      const services =
        typeof r.ВыбранныеУслуги === "string"
          ? JSON.parse(r.ВыбранныеУслуги)
          : r.ВыбранныеУслуги;

      // Применяем скидку 3% если у пользователя 3+ заявок
      const hasDiscount = discountUsers.includes(r.ID_Пользователя);
      const discount = hasDiscount ? 0.97 : 1;
      const discountedPrice = Math.round(r.Цена * discount);

      return {
        ...r,
        ВыбранныеУслуги: services,
        Статус: r.Статус || "Новая",
        Цена: discountedPrice,
        ИсходнаяЦена: r.Цена,
        Скидка: hasDiscount ? "3%" : "Нет",
      };
    });

    res.json(formattedRequests);
  } catch (error) {
    console.error("Ошибка:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Удаление заявки
app.delete("/api/admin/requests/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Лучше пометить как выполненную, а не удалять
    const [result] = await db.query(
      'UPDATE Заявки SET Статус = "Завершена" WHERE ID = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Заявка не найдена" });
    }

    res.json({ message: "Заявка завершена" });
  } catch (error) {
    console.error("Ошибка при завершении заявки:", error);
    res.status(500).json({ error: "Не удалось завершить заявку" });
  }
});

// middleware для логирования запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body) console.log("Body:", req.body);
  next();
});

// Обновленный endpoint авторизации
app.post("/api/login", async (req, res) => {
  try {
    const { login, password } = req.body;
    console.log("Login attempt:", login); // Логирование попытки входа

    if (!login || !password) {
      console.log("Empty credentials");
      return res.status(400).json({ error: "Логин и пароль обязательны" });
    }

    const [users] = await db.query(
      `SELECT п.*, р.Наименование AS Роль 
       FROM Пользователи п
       JOIN Роль р ON п.ID_Роли = р.ID
       WHERE п.Логин = ?`,
      [login]
    );

    console.log("Found users:", users); // Логирование найденных пользователей

    if (users.length === 0) {
      console.log("User not found");
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    const user = users[0];

    // Простое сравнение паролей
    if (password !== user.Пароль) {
      console.log("Password mismatch");
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    console.log("Login successful for user:", user.Логин);
    res.json({
      id: user.ID,
      login: user.Логин,
      role: user.Роль,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      error: "Ошибка сервера",
      details: error.message,
    });
  }
});

// Регистрация
app.post("/api/register", async (req, res) => {
  try {
    const { login, password } = req.body;

    // Проверка существующего пользователя
    const [existing] = await db.query(
      "SELECT ID FROM Пользователи WHERE Логин = ?",
      [login]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "Логин уже занят" });
    }

    // Добавляем пользователя с ролью "Пользователь" (ID=2)
    await db.query(
      `INSERT INTO Пользователи (Логин, Пароль, ID_Роли) 
       VALUES (?, ?, 2)`,
      [login, password] // Пароль сохраняется как есть
    );

    res.status(201).json({ message: "Регистрация успешна" });
  } catch (error) {
    console.error("Ошибка регистрации:", error);
    res.status(500).json({
      error: "Ошибка сервера",
      details: error.message,
    });
  }
});

// Получение информации об услуге
app.get("/api/services/:id", async (req, res) => {
  console.log(`Запрос информации об услуге ID: ${req.params.id}`); // Логирование
  try {
    const { id } = req.params;
    const [services] = await db.query("SELECT * FROM Услуги WHERE ID = ?", [
      id,
    ]);
    console.log("Результат запроса:", services); // Логирование

    if (services.length === 0) {
      console.log("Услуга не найдена");
      return res.status(404).json({ error: "Услуга не найдена" });
    }

    res.json(services[0]);
  } catch (error) {
    console.error("Ошибка при получении услуги:", error);
    res.status(500).json({ error: "Не удалось получить услугу" });
  }
});

// Получение всех отзывов для услуги
app.get("/api/services/:id/reviews", async (req, res) => {
  console.log(`Запрос отзывов для услуги ID: ${req.params.id}`); // Логирование
  try {
    const { id } = req.params;

    const [reviews] = await db.query(
      `
      SELECT 
        о.ID,
        о.Оценка, 
        о.Текст, 
        о.Дата_создания,
        п.Логин AS Пользователь
      FROM Отзывы о
      JOIN Пользователи п ON о.ID_Пользователя = п.ID
      WHERE о.ID_Услуги = ?
      ORDER BY о.Дата_создания DESC
    `,
      [id]
    );

    console.log("Найдено отзывов:", reviews.length); // Логирование
    res.json(reviews);
  } catch (error) {
    console.error("Ошибка при получении отзывов:", error);
    res.status(500).json({ error: "Не удалось получить отзывы" });
  }
});
// Добавление отзыва
app.post("/api/reviews", async (req, res) => {
  try {
    const { userId, serviceId, rating, text } = req.body;

    // Проверка данных
    if (!userId || !serviceId || !rating || !text) {
      return res.status(400).json({ error: "Все поля обязательны" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Оценка должна быть от 1 до 5" });
    }

    await db.query(
      `INSERT INTO Отзывы 
       (ID_Пользователя, ID_Услуги, Оценка, Текст)
       VALUES (?, ?, ?, ?)`,
      [userId, serviceId, rating, text]
    );

    res.status(201).json({ message: "Отзыв добавлен" });
  } catch (error) {
    console.error("Ошибка при добавлении отзыва:", error);
    res.status(500).json({ error: "Не удалось добавить отзыв" });
  }
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Сервер запущен на http://localhost:${port}`);
});
