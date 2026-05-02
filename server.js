const express = require('express');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const SECRET_KEY = 'bebas-isi-apa-saja-yang-penting-rahasia'; 

const { createClient } = require('@libsql/client');

// --- 1. SETUP DATABASE TURSO ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Fungsi pembuat tabel otomatis saat pertama dijalankan
(async () => {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                fullname TEXT, 
                email TEXT UNIQUE, 
                username TEXT UNIQUE, 
                password TEXT
            );
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS cvs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                user_id INTEGER, 
                title TEXT, 
                content TEXT, 
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database Turso Siap dan Terkoneksi!");
    } catch (err) {
        console.error("Gagal inisialisasi tabel Turso:", err);
    }
})();

// --- 2. MIDDLEWARE KEAMANAN ---
const auth = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
    try {
        const verified = jwt.verify(token, SECRET_KEY);
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Sesi habis, silakan login ulang.' });
    }
};

// --- 3. FUNGSI UTAMA AI ---
async function askAI(prompt, retries = 3) {
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    let delay = 2000;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }]
            });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            const status = error.response ? error.response.status : null;
            if (status === 503 || status === 429) {
                if (i < retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2;
                    continue; 
                }
            }
            return "Maaf, server AI sedang sibuk. Silakan coba lagi.";
        }
    }
}

// --- 4. API AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    const { fullname, email, username, password } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Format email tidak valid!' });

    const hashedPw = await bcrypt.hash(password, 10);
    try {
        await db.execute({
            sql: 'INSERT INTO users (fullname, email, username, password) VALUES (?, ?, ?, ?)',
            args: [fullname, email, username, hashedPw]
        });
        res.json({ message: 'Registrasi Berhasil!' });
    } catch (e) { 
        res.status(400).json({ error: 'Username atau Email sudah terdaftar!' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE username = ?',
            args: [username]
        });
        const user = result.rows[0];

        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign({ id: Number(user.id), username: user.username }, SECRET_KEY, { expiresIn: '1d' });
            res.cookie('token', token, { httpOnly: true }).json({ message: 'Login Berhasil' });
        } else { 
            res.status(400).json({ error: 'Username atau Password salah!' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Gagal Login' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token').json({ message: 'Logout berhasil' });
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { username, email, newPassword } = req.body;
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE username = ? AND email = ?',
            args: [username, email]
        });
        const user = result.rows[0];

        if (!user) return res.status(400).json({ error: 'Data tidak valid!' });

        const hashedPw = await bcrypt.hash(newPassword, 10);
        await db.execute({
            sql: 'UPDATE users SET password = ? WHERE id = ?',
            args: [hashedPw, user.id]
        });
        res.json({ message: 'Password berhasil diubah!' });
    } catch (e) {
        res.status(500).json({ error: 'Gagal reset password' });
    }
});

// --- 5. API AI CV ---
app.post('/api/ai/job-desc', async (req, res) => {
    const { title, company } = req.body;
    const prompt = `Buatkan 3 poin deskripsi pekerjaan profesional untuk posisi ${title} di ${company}. Langsung poin saja dengan '-'.`;
    const result = await askAI(prompt);
    res.json({ text: result });
});

app.post('/api/ai/skills', async (req, res) => {
    const { jobs, education } = req.body;
    const prompt = `Daftar 6-8 hard skills untuk pengalaman ${jobs} dan pendidikan ${education}. Hanya nama skill pisah koma.`;
    const result = await askAI(prompt);
    res.json({ text: result });
});

app.post('/api/ai/summary', async (req, res) => {
    const { skills } = req.body;
    const prompt = `Buatkan professional summary 3 kalimat untuk keahlian ${skills}. Bahasa Indonesia, tanpa nama.`;
    const result = await askAI(prompt);
    res.json({ text: result });
});

// --- 6. API SIMPAN CV ---
app.post('/api/cv/save', auth, async (req, res) => {
    try {
        await db.execute({
            sql: 'INSERT INTO cvs (user_id, title, content) VALUES (?, ?, ?)',
            args: [req.user.id, req.body.title, JSON.stringify(req.body.content)]
        });
        res.json({ message: 'CV Berhasil Disimpan!' });
    } catch (e) { 
        res.status(500).json({ error: 'Gagal menyimpan CV' }); 
    }
});

app.get('/api/cv/list', auth, async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT id, title, created_at FROM cvs WHERE user_id = ? ORDER BY id DESC',
            args: [req.user.id]
        });
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Gagal mengambil daftar CV' });
    }
});

app.delete('/api/cv/delete/:id', auth, async (req, res) => {
    try {
        await db.execute({
            sql: 'DELETE FROM cvs WHERE id = ? AND user_id = ?',
            args: [req.params.id, req.user.id]
        });
        res.json({ message: 'CV Berhasil Dihapus' });
    } catch (e) { 
        res.status(500).json({ error: 'Gagal menghapus CV' }); 
    }
});

app.get('/api/cv/detail/:id', auth, async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM cvs WHERE id = ? AND user_id = ?',
            args: [req.params.id, req.user.id]
        });
        if (result.rows[0]) res.json(result.rows[0]);
        else res.status(404).json({ error: 'CV tidak ditemukan' });
    } catch (e) { 
        res.status(500).json({ error: 'Gagal mengambil CV' }); 
    }
});

// --- 7. API ADMIN ---
app.get('/api/admin/users', async (req, res) => {
    if (req.query.pass !== 'Baph0met123') return res.status(403).send("Akses Ditolak");
    try {
        const result = await db.execute('SELECT id, fullname, email, username FROM users');
        let html = `<table border="1"><tr><th>ID</th><th>Nama</th><th>Email</th><th>User</th></tr>`;
        result.rows.forEach(u => {
            html += `<tr><td>${u.id}</td><td>${u.fullname}</td><td>${u.email}</td><td>${u.username}</td></tr>`;
        });
        res.send(html + "</table>");
    } catch (e) { res.status(500).send("Error database"); }
});

// --- BAGIAN KHUSUS VERCEL ---
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Server berjalan di port 3000'));
}

module.exports = app;