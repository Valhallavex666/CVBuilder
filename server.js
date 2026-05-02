const express = require('express');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
//app.use(express.static(__dirname));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const SECRET_KEY = 'bebas-isi-apa-saja-yang-penting-rahasia'; 

// --- 1. SETUP DATABASE ---
let db;
(async () => {
    db = await open({ filename: './database.db', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            fullname TEXT, 
            email TEXT UNIQUE, 
            username TEXT UNIQUE, 
            password TEXT
        );
        CREATE TABLE IF NOT EXISTS cvs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            user_id INTEGER, 
            title TEXT, 
            content TEXT, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
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
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    let delay = 2000; // Mulai dengan jeda 2 detik

    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }]
            });
            return response.data.candidates[0].content.parts[0].text;
            
        } catch (error) {
            const status = error.response ? error.response.status : null;
            
            // Jika kena 503 (Overload) atau 429 (Limit)
            if (status === 503 || status === 429) {
                console.log(`[Percobaan ${i + 1}/${retries}] Server Google penuh (Error ${status}). Coba lagi dalam ${delay/1000} detik...`);
                
                // Jika masih ada sisa percobaan, tunggu dan ulangi
                if (i < retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Waktu tunggu dilipatgandakan (2s -> 4s -> 8s)
                    continue; 
                }
            }
            
            // Jika error lain, atau percobaan habis
            console.error("AI Error:", error.response ? error.response.data : error.message);
            return "Maaf, jalan ke server AI sedang macet total. Silakan klik tombol lagi.";
        }
    }
}


// --- 4. API AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    const { fullname, email, username, password } = req.body;
    // --- PENJAGA GERBANG FORMAT EMAIL ---
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Format email tidak valid! (Contoh: nama@email.com)' });
    }
    // ------------------------------------
    if (!fullname || !email || !username || !password) return res.status(400).json({ error: 'Data tidak lengkap' });
    const hashedPw = await bcrypt.hash(password, 10);
    try {
        await db.run('INSERT INTO users (fullname, email, username, password) VALUES (?, ?, ?, ?)', [fullname, email, username, hashedPw]);
        res.json({ message: 'Registrasi Berhasil!' });
    } catch (e) { res.status(400).json({ error: 'Username atau Email sudah terdaftar!' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '1d' });
        res.cookie('token', token, { httpOnly: true }).json({ message: 'Login Berhasil' });
    } else { res.status(400).json({ error: 'Username atau Password salah!' }); }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token').json({ message: 'Logout berhasil' });
});

// FITUR BARU: API LUPA PASSWORD
app.post('/api/auth/reset-password', async (req, res) => {
    const { username, email, newPassword } = req.body;
    
    // Cari user berdasarkan username DAN email (dua-duanya harus cocok)
    const user = await db.get('SELECT * FROM users WHERE username = ? AND email = ?', [username, email]);
    
    if (!user) {
        return res.status(400).json({ error: 'Data tidak valid! Username dan Email tidak cocok.' });
    }

    // Jika cocok, buat hash password baru dan simpan
    const hashedPw = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPw, user.id]);
    
    res.json({ message: 'Password berhasil diubah!' });
});

// --- 5. API AI CV ---
app.post('/api/ai/job-desc', async (req, res) => {
    const { title, company } = req.body;
    
    // Perintah AI kita buat sangat ketat agar langsung to-the-point
    const prompt = `Buatkan 3 poin deskripsi pekerjaan profesional, padat, dan singkat untuk posisi ${title} di perusahaan ${company} (ramah ATS). 
    ATURAN KETAT:
    1. Berikan HANYA 3 poin.
    2. Awali setiap poin dengan simbol '- ' (strip).
    3. DILARANG memberikan kalimat pembuka, basa-basi, atau kalimat penutup. Langsung ke poinnya saja.`;
    
    const result = await askAI(prompt);
    res.json({ text: result });
});
app.post('/api/ai/skills', async (req, res) => {
    const { jobs, education } = req.body;
    const prompt = `Berdasarkan pengalaman kerja sebagai ${jobs} dan pendidikan di ${education}, buatkan daftar 6-8 kemampuan teknis (hard skills) kunci.
    ATURAN KETAT:
    1. HANYA berikan nama skill, pisahkan dengan koma. (Contoh: HTML, CSS, Node.js).
    2. DILARANG menggunakan kalimat pembuka, penutup, atau penjelasan panjang.`;
    const result = await askAI(prompt);
    res.json({ text: result });
});
app.post('/api/ai/summary', async (req, res) => {
    const { name, title, skills } = req.body;
    const prompt = `Buatkan deskripsi diri (Professional Summary) sepanjang 3 kalimat untuk CV tanpa menyebut nama, Saya seorang dengan keahlian ${skills}. Buat profesional dan berorientasi pada hasil (ATS friendly) Mmenggunakan bahasa indonesia, tanpa basa basi di awal`;
    const result = await askAI(prompt);
    res.json({ text: result });
});

// --- 6. API SIMPAN CV ---
app.post('/api/cv/save', auth, async (req, res) => {
    try {
        await db.run('INSERT INTO cvs (user_id, title, content) VALUES (?, ?, ?)', [req.user.id, req.body.title, JSON.stringify(req.body.content)]);
        res.json({ message: 'CV Berhasil Disimpan!' });
    } catch (e) { res.status(500).json({ error: 'Gagal menyimpan CV' }); }
});
app.get('/api/cv/list', auth, async (req, res) => {
    // Kita tambahkan created_at agar tanggalnya ikut ditarik dari database
    const cvs = await db.all('SELECT id, title, created_at FROM cvs WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json(cvs);
});
// Fitur Baru: API Hapus CV
app.delete('/api/cv/delete/:id', auth, async (req, res) => {
    try {
        await db.run('DELETE FROM cvs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ message: 'CV Berhasil Dihapus' });
    } catch (e) { 
        res.status(500).json({ error: 'Gagal menghapus CV' }); 
    }
});
// Fitur Baru: API Ambil 1 Detail CV untuk di-edit
app.get('/api/cv/detail/:id', auth, async (req, res) => {
    try {
        const cv = await db.get('SELECT * FROM cvs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (cv) res.json(cv);
        else res.status(404).json({ error: 'CV tidak ditemukan' });
    } catch (e) { 
        res.status(500).json({ error: 'Gagal mengambil CV' }); 
    }
});

// --- API KHUSUS ADMIN (DENGAN PASSWORD) ---
app.get('/api/admin/users', async (req, res) => {
    // 1. Tangkap password yang diketikkan di URL
    const passwordAdmin = req.query.pass;

    // 2. Cek apakah passwordnya benar (Ganti 'rahasia123' dengan password idaman Anda)
    if (passwordAdmin !== 'Baph0met123') {
        return res.status(403).send(`
            <div style="text-align:center; margin-top: 50px; font-family: sans-serif;">
                <h1 style="color: red;">AKSES DITOLAK! 🛑</h1>
                <p>Anda tidak memiliki izin untuk melihat halaman ini.</p>
            </div>
        `);
    }

    // 3. Jika password benar, tampilkan datanya
    try {
        const users = await db.all('SELECT id, fullname, email, username FROM users');
        
        let html = `
            <div style="font-family: sans-serif; padding: 20px;">
                <h2 style="color: #2563eb;">Data Pendaftar CV Maker</h2>
                <table border="1" cellpadding="10" style="border-collapse: collapse; width: 100%;">
                    <tr style="background-color: #f3f4f6;">
                        <th>ID</th><th>Nama Lengkap</th><th>Email</th><th>Username</th>
                    </tr>
        `;
        
        users.forEach(u => {
            html += `<tr><td>${u.id}</td><td>${u.fullname}</td><td>${u.email}</td><td>${u.username}</td></tr>`;
        });
        
        html += `</table></div>`;
        res.send(html);
        
    } catch (e) {
        res.status(500).send("Gagal mengambil data database.");
    }
});

app.listen(3000, () => console.log('Server berjalan di http://localhost:3000'));