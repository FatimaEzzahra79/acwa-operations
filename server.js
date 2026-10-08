require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Pas de secret codé en dur : si JWT_SECRET est absent, on génère un secret
// éphémère (les sessions sont alors invalidées à chaque redémarrage).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET manquant dans .env — secret éphémère généré. Sessions invalidées au redémarrage.');
}

// ===== CONNEXION MYSQL =====
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'noor_inventory',
    port: parseInt(process.env.DB_PORT || '3306')
});

db.connect((err) => {
    if (err) {
        console.error('❌ Erreur MySQL:', err);
        return;
    }
    console.log('✅ Connecté à MySQL');

    // Créer la table users
    db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            name VARCHAR(100) NOT NULL,
            role ENUM('admin', 'user') DEFAULT 'user',
            reset_token VARCHAR(255) NULL,
            reset_token_expiry DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Erreur création table users:', err);
        else {
            // Compte admin créé au premier démarrage.
            // Aucun identifiant par défaut n'est livré avec le dépôt :
            // le mot de passe vient de ADMIN_SEED_PASSWORD (.env) ou est
            // généré aléatoirement et affiché une seule fois en console.
            const seedPassword = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(12).toString('base64url');
            const hashed = bcrypt.hashSync(seedPassword, 10);
            db.query(
                'INSERT IGNORE INTO users (id, email, password, name, role) VALUES (1, ?, ?, ?, ?)',
                ['admin@acwa.com', hashed, 'Administrator', 'admin'],
                (e, result) => {
                    if (!e && result && result.affectedRows > 0) {
                        console.log('✅ Compte admin créé :');
                        console.log('   email    : admin@acwa.com');
                        console.log(`   password : ${seedPassword}`);
                    }
                }
            );
            // Migration legacy SHA-256 -> bcrypt : un hash SHA-256 n'est pas
            // réversible, le mot de passe est donc régénéré et affiché en console.
            db.query("SELECT id, email, password FROM users WHERE password NOT LIKE '$2%'", (err2, rows) => {
                if (!err2 && rows.length) {
                    rows.forEach(u => {
                        const resetTo = u.id === 1 ? seedPassword : crypto.randomBytes(12).toString('base64url');
                        const newHash = bcrypt.hashSync(resetTo, 10);
                        db.query('UPDATE users SET password = ? WHERE id = ?', [newHash, u.id]);
                        console.log(`🔄 ${u.email} migré vers bcrypt — mot de passe : ${resetTo}`);
                    });
                }
            });
            console.log('✅ Utilisateur admin créé');
        }
    });

    // Créer la table pdf_history (historique des PDF générés)
    db.query(`
        CREATE TABLE IF NOT EXISTS pdf_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            file_name VARCHAR(255) NOT NULL,
            type VARCHAR(50),
            permit_number VARCHAR(20) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Erreur création table pdf_history:', err);
    });

    // Migration: ajouter la colonne unit_weight à materials + backfill
    db.query(`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'materials' AND COLUMN_NAME = 'unit_weight'`,
        (err, rows) => {
            if (err) { console.error('Erreur vérification colonne unit_weight:', err); return; }
            if (rows[0].n === 0) {
                db.query(`ALTER TABLE materials ADD COLUMN unit_weight DECIMAL(10,2) NULL AFTER quantity`, (err2) => {
                    if (err2) { console.error('Erreur ajout colonne unit_weight:', err2); return; }
                    db.query(`UPDATE materials SET unit_weight = ROUND(weight / quantity, 2) WHERE quantity > 0 AND unit_weight IS NULL`, (err3) => {
                        if (err3) console.error('Erreur backfill unit_weight:', err3);
                        else console.log('✅ Colonne unit_weight ajoutée (calcule automatique du poids)');
                    });
                });
            }
        });
});

// ===== UPLOADS FOLDER + MULTER =====
const uploadsDir = path.join(__dirname, 'uploads', 'materials');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, 'mat_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Migration: ajouter la colonne photo à materials
db.query(`SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'materials' AND COLUMN_NAME = 'photo'`,
    (err, rows) => {
        if (err) { console.error('Erreur vérification colonne photo:', err); return; }
        if (rows[0].n === 0) {
            db.query(`ALTER TABLE materials ADD COLUMN photo VARCHAR(500) NULL AFTER movement_type`, (err2) => {
                if (err2) console.error('Erreur ajout colonne photo:', err2);
                else console.log('✅ Colonne photo ajoutée à materials');
            });
        }
    });

// ===== MIDDLEWARE =====
// CORS fermé par défaut : le front est servi par ce même serveur, aucune
// origine externe n'a besoin d'appeler l'API. Origines tierces à déclarer
// explicitement via ALLOWED_ORIGINS (liste séparée par des virgules).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
if (allowedOrigins.length) app.use(cors({ origin: allowedOrigins }));

// Derrière un reverse proxy (ngrok), activer : TRUST_PROXY=1
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// En-têtes de sécurité HTTP
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

app.use(bodyParser.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

// ===== PROTECTION BRUTE FORCE =====
// 10 échecs simultanés maximum par IP sur 15 minutes ; les logins réussis
// ne sont pas comptés pour ne jamais bloquer un utilisateur légitime.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, error: 'Trop de tentatives échouées. Réessayez dans 15 minutes.' }
});

// =============================================
// AUTH - LOGIN (bcrypt + JWT)
// =============================================
app.post('/api/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email et mot de passe requis' });
    }

    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Erreur base de données' });
        }

        if (results.length === 0) {
            return res.status(401).json({ success: false, error: 'Identifiants incorrects' });
        }

        const user = results[0];
        let ok = false;

        if (user.password.startsWith('$2')) {
            ok = await bcrypt.compare(password, user.password);
        } else {
            // Ancien hash SHA256: vérifier puis migrer vers bcrypt
            const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
            if (legacyHash === user.password) {
                ok = true;
                const upgraded = bcrypt.hashSync(password, 10);
                db.query('UPDATE users SET password = ? WHERE id = ?', [upgraded, user.id]);
                console.log(`🔄 Compte ${email} migré vers bcrypt`);
            }
        }

        if (!ok) {
            return res.status(401).json({ success: false, error: 'Identifiants incorrects' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role
            },
            token: token
        });
    });
});

// =============================================
// AUTH - MOT DE PASSE OUBLIÉ
// =============================================
app.post('/api/forgot-password', authLimiter, (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, error: 'Email requis' });
    }

    db.query('SELECT id, email, name FROM users WHERE email = ?', [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Erreur base de données' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, error: 'Email non trouvé' });
        }

        const user = results[0];
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 3600000);

        db.query(
            'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
            [resetToken, expiry, user.id],
            (err) => {
                if (err) {
                    return res.status(500).json({ success: false, error: 'Erreur lors de la création du token' });
                }

                // Simuler l'envoi d'email (à configurer avec nodemailer)
                console.log(`📧 Lien de réinitialisation : http://localhost:3000/reset-password.html?token=${resetToken}`);

                res.json({ success: true, message: 'Email de réinitialisation envoyé' });
            }
        );
    });
});

// =============================================
// AUTH - VÉRIFIER TOKEN
// =============================================
app.post('/api/verify-reset-token', (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ success: false, error: 'Token requis' });
    }

    db.query(
        'SELECT id, email FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()',
        [token],
        (err, results) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Erreur base de données' });
            }

            if (results.length === 0) {
                return res.status(401).json({ success: false, error: 'Token invalide ou expiré' });
            }

            res.json({ success: true, user: results[0] });
        }
    );
});

// =============================================
// AUTH - RÉINITIALISER LE MOT DE PASSE (avec bcrypt)
// =============================================
app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ success: false, error: 'Token et nouveau mot de passe requis' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    db.query(
        'SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()',
        [token],
        async (err, results) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Erreur base de données' });
            }

            if (results.length === 0) {
                return res.status(401).json({ success: false, error: 'Token invalide ou expiré' });
            }

            const hashed = await bcrypt.hash(newPassword, 10);
            db.query(
                'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
                [hashed, results[0].id],
                (err2) => {
                    if (err2) {
                        return res.status(500).json({ success: false, error: 'Erreur lors de la réinitialisation' });
                    }
                    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès' });
                }
            );
        }
    );
});

// =============================================
// MIDDLEWARE D'AUTHENTIFICATION JWT
// Toutes les routes /api/* définies APRÈS ce point sont protégées
// =============================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Non autorisé: token manquant' });
    }

    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) {
            return res.status(401).json({ success: false, error: 'Session expirée, reconnectez-vous' });
        }
        req.user = payload;
        next();
    });
}

app.use('/api', authenticateToken);

// =============================================
// AUTH - CHANGER LE MOT DE PASSE (protégé: id depuis le JWT)
// =============================================
app.post('/api/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user ? req.user.id : null;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, error: 'Tous les champs sont requis' });
    }

    if (!userId) {
        return res.status(401).json({ success: false, error: 'Non autorisé' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    db.query('SELECT password FROM users WHERE id = ?', [userId], async (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Erreur base de données' });
        }

        if (results.length === 0) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }

        const stored = results[0].password;
        let ok = stored.startsWith('$2')
            ? await bcrypt.compare(currentPassword, stored)
            : crypto.createHash('sha256').update(currentPassword).digest('hex') === stored;

        if (!ok) {
            return res.status(401).json({ success: false, error: 'Mot de passe actuel incorrect' });
        }

        const hashedNew = bcrypt.hashSync(newPassword, 10);
        db.query(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedNew, userId],
            (err2) => {
                if (err2) {
                    return res.status(500).json({ success: false, error: 'Erreur lors du changement' });
                }
                res.json({ success: true, message: 'Mot de passe changé avec succès' });
            }
        );
    });
});

// =============================================
// API - UTILISATEUR COURANT (rôle frais depuis la DB)
// =============================================
app.get('/api/me', (req, res) => {
    db.query('SELECT id, email, name, role FROM users WHERE id = ?', [req.user.id], (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        if (results.length === 0) { res.status(404).json({ success: false, error: 'Utilisateur non trouvé' }); return; }
        const u = results[0];
        res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
    });
});

// =============================================
// GESTION DES UTILISATEURS (admin uniquement)
// =============================================
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Accès réservé aux administrateurs' });
    }
    next();
}

app.get('/api/users', requireAdmin, (req, res) => {
    db.query('SELECT id, email, name, role, created_at AS createdAt FROM users ORDER BY id', (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/users', requireAdmin, async (req, res) => {
    const { email, name, password, role } = req.body;

    if (!email || !name || !password) {
        return res.status(400).json({ success: false, error: 'Email, nom et mot de passe requis' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }
    const userRole = (role === 'admin') ? 'admin' : 'user';

    db.query('SELECT id FROM users WHERE email = ?', [email], async (err, existing) => {
        if (err) { return res.status(500).json({ success: false, error: err.message }); }
        if (existing.length > 0) {
            return res.status(409).json({ success: false, error: 'Cet email est déjà utilisé' });
        }
        const hashed = await bcrypt.hash(password, 10);
        db.query(
            'INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)',
            [email, hashed, name, userRole],
            (err2, result) => {
                if (err2) { return res.status(500).json({ success: false, error: err2.message }); }
                res.json({ success: true, message: 'Utilisateur créé', id: result.insertId });
            }
        );
    });
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { name, role, password } = req.body;
    const updates = [];
    const params = [];

    if (name) { updates.push('name = ?'); params.push(name); }
    if (role) {
        if (req.user.id === id && role !== 'admin') {
            return res.status(400).json({ success: false, error: 'Vous ne pouvez pas retirer votre propre rôle admin' });
        }
        updates.push('role = ?'); params.push(role === 'admin' ? 'admin' : 'user');
    }
    if (password) {
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Le mot de passe doit contenir au moins 6 caractères' });
        }
        updates.push('password = ?'); params.push(await bcrypt.hash(password, 10));
    }

    if (!updates.length) {
        return res.status(400).json({ success: false, error: 'Aucune modification fournie' });
    }

    params.push(id);
    db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, (err, result) => {
        if (err) { return res.status(500).json({ success: false, error: err.message }); }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
        }
        res.json({ success: true, message: 'Utilisateur mis à jour' });
    });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id);

    if (req.user.id === id) {
        return res.status(400).json({ success: false, error: 'Vous ne pouvez pas supprimer votre propre compte' });
    }

    db.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin'", (err, rows) => {
        if (err) { return res.status(500).json({ success: false, error: err.message }); }
        if (rows[0].admins <= 1) {
            return res.status(400).json({ success: false, error: 'Impossible de supprimer le dernier administrateur' });
        }
        db.query('DELETE FROM users WHERE id = ?', [id], (err2, result) => {
            if (err2) { return res.status(500).json({ success: false, error: err2.message }); }
            if (result.affectedRows === 0) {
                return res.status(404).json({ success: false, error: 'Utilisateur non trouvé' });
            }
            res.json({ success: true, message: 'Utilisateur supprimé' });
        });
    });
});

// =============================================
// API - PERMITS
// =============================================
app.get('/api/permits', (req, res) => {
    db.query(`SELECT permit_number AS permitNumber, permit_date AS permitDate, company_name AS companyName,
              company_address AS companyAddress, substance_destination AS substance, type, status,
              created_at AS createdAt, updated_at AS updatedAt
              FROM permit_details ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/permits', (req, res) => {
    const { permitNumber, permitDate, companyName, companyAddress, substance, type } = req.body;
    if (!permitNumber || !permitDate || !companyName || !companyAddress) {
        return res.status(400).json({ success: false, error: 'Champs obligatoires manquants' });
    }
    db.query(
        `INSERT INTO permit_details (permit_number, permit_date, company_name, company_address, substance_destination, type, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [permitNumber, permitDate, companyName, companyAddress, substance || null, type || 'IN'],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ success: false, error: 'Ce numéro de permis existe déjà' });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Permit created', permit_number: permitNumber });
        }
    );
});

// Mettre à jour le statut d'un permis (pending → returnable → closed)
app.put('/api/permits/:permit_number', (req, res) => {
    const { permit_number } = req.params;
    const { status } = req.body;
    const allowed = ['pending', 'approved', 'returnable', 'closed'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ success: false, error: 'Statut invalide' });
    }
    db.query('UPDATE permit_details SET status = ? WHERE permit_number = ?', [status, permit_number], (err, result) => {
        if (err) { res.status(500).json({ success: false, error: err.message }); return; }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Permis non trouvé' });
        }
        res.json({ success: true, message: `Permit ${permit_number} updated to ${status}` });
    });
});

app.delete('/api/permits/:permit_number', (req, res) => {
    const { permit_number } = req.params;
    db.query('DELETE FROM permit_details WHERE permit_number = ?', [permit_number], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Permit deleted' });
    });
});

app.get('/api/stats', (req, res) => {
    db.query('SELECT COUNT(*) as total FROM permit_details', (err, totalResult) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        db.query('SELECT COUNT(*) as outCount FROM permit_details WHERE type = "OUT"', (err, outResult) => {
            if (err) { res.status(500).json({ error: err.message }); return; }
            db.query('SELECT COUNT(*) as inCount FROM permit_details WHERE type = "IN"', (err, inResult) => {
                if (err) { res.status(500).json({ error: err.message }); return; }
                db.query('SELECT COUNT(*) as pendingCount FROM permit_details WHERE status = "pending"', (err, pendingResult) => {
                    if (err) { res.status(500).json({ error: err.message }); return; }
                    res.json({
                        total: totalResult[0].total,
                        out: outResult[0].outCount,
                        in: inResult[0].inCount,
                        pending: pendingResult[0].pendingCount
                    });
                });
            });
        });
    });
});

// =============================================
// API - MATERIALS
// =============================================
app.get('/api/materials', (req, res) => {
    db.query(`SELECT id, equipment_no AS equipmentNo, permit_number AS permitNumber, description,
              quantity, unit_weight AS unitWeight, weight, movement_type AS type, photo, created_at AS createdAt
              FROM materials ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/materials', (req, res) => {
    const { equipmentNo, permitNumber, description, quantity, unitWeight, weight, type } = req.body;
    const qty = parseFloat(quantity) || 0;
    const uw = parseFloat(unitWeight);
    const computedWeight = (!isNaN(uw) && qty > 0)
        ? Math.round(qty * uw * 100) / 100
        : (parseFloat(weight) || 0);
    db.query(
        `INSERT INTO materials (equipment_no, permit_number, description, quantity, unit_weight, weight, movement_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [equipmentNo, permitNumber, description, quantity, isNaN(uw) ? null : uw, computedWeight, type],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                    return res.status(400).json({ success: false, error: 'Permis introuvable: créez d\'abord le permis ' + permitNumber });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Material created', id: result.insertId });
        }
    );
});

app.delete('/api/materials/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM materials WHERE id = ?', [id], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Material deleted' });
    });
});

// ===== UPLOAD PHOTO FOR MATERIAL =====
app.post('/api/materials/:id/photo', upload.single('photo'), (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const photoPath = 'uploads/materials/' + req.file.filename;
    db.query('UPDATE materials SET photo = ? WHERE id = ?', [photoPath, id], (err) => {
        if (err) { res.status(500).json({ success: false, error: err.message }); return; }
        res.json({ success: true, message: 'Photo uploaded', photo: photoPath });
    });
});

// =============================================
// API - EXPORT EXCEL (général: permits + materials + photos)
// =============================================
function q(sql, params) {
    return new Promise((resolve, reject) => db.query(sql, params, (e, r) => e ? reject(e) : resolve(r)));
}

const xlsxHeaderStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } },
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
};
const xlsxCellBorder = {
    top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' }
};

app.get('/api/export/permits-excel', async (req, res) => {
    try {
        const [permits, materials, transports, security, contractors, approvals] = await Promise.all([
            q(`SELECT permit_number AS permitNumber, DATE_FORMAT(permit_date, '%d/%m/%Y') AS permitDate,
               company_name AS companyName, company_address AS companyAddress,
               substance_destination AS substance, type, status, created_at AS createdAt,
               updated_at AS updatedAt FROM permit_details ORDER BY created_at DESC`),
            q(`SELECT id, equipment_no AS equipmentNo, permit_number AS permitNumber, description,
               quantity, unit_weight AS unitWeight, weight, movement_type AS type, photo
               FROM materials ORDER BY equipment_no ASC`),
            q(`SELECT id, name_id AS driverName, vehicle_plate AS vehiclePlate, date_time AS dateTime,
               permit_number AS permitNumber FROM transports ORDER BY date_time DESC`),
            q(`SELECT id, name_id AS officerName, date_time AS dateTime, remark AS remarks,
               signature_status AS signature, permit_number AS permitNumber FROM security_checks ORDER BY date_time DESC`),
            q(`SELECT id, contractor_id AS contractorId, reason, reference_number AS referenceNumber,
               is_returnable AS returnable, signature_status AS signature, permit_number AS permitNumber
               FROM contractor_details ORDER BY id DESC`),
            q(`SELECT id, approval_id AS approvalId, division_name AS divisionName, approver_name AS approverName,
               signature_status AS signature, permit_number AS permitNumber FROM approvals ORDER BY id DESC`)
        ]);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'ACWA Operations';
        wb.created = new Date();

        // ===== HELPERS =====
        const groupBy = (arr, key) => arr.reduce((acc, item) => {
            (acc[item[key]] = acc[item[key]] || []).push(item);
            return acc;
        }, {});

        const materialsByPermit = groupBy(materials, 'permitNumber');
        const transportsByPermit = groupBy(transports, 'permitNumber');
        const securityByPermit = groupBy(security, 'permitNumber');
        const contractorsByPermit = groupBy(contractors, 'permitNumber');
        const approvalsByPermit = groupBy(approvals, 'permitNumber');

        // ===== ORANGE HEADER STYLE =====
        const orangeHeaderStyle = {
            font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } },
            alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
            border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
        };
        const cellBorder = {
            top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
            bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
            left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
            right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
        };

        // ===== SHEET 1: GÉNÉRAL (16 colonnes exactes) =====
        const wsG = wb.addWorksheet('Général');
        wsG.columns = [
            { header: 'Date',                    key: 'date',              width: 14 },
            { header: 'IN/OUT No',               key: 'permitNumber',      width: 16 },
            { header: 'Security Guard Name',      key: 'securityGuard',     width: 24 },
            { header: 'Company in charge (IN/OUT)', key: 'companyCharge',   width: 28 },
            { header: 'Name Responsible Person',  key: 'responsiblePerson', width: 28 },
            { header: 'Material Description',     key: 'materialDesc',      width: 35 },
            { header: 'Quantity (#)',             key: 'quantity',          width: 12 },
            { header: 'Purpose',                  key: 'purpose',           width: 22 },
            { header: 'IN/OUT',                   key: 'inOut',             width: 10 },
            { header: 'To be returned (Yes/No)',  key: 'toBeReturned',      width: 20 },
            { header: 'Evidence',                 key: 'evidence',          width: 24 },
            { header: 'Expected Return Date',     key: 'expectedReturn',    width: 22 },
            { header: 'Actual Return Date',       key: 'actualReturn',      width: 20 },
            { header: 'Returned Quantity',        key: 'returnedQty',       width: 18 },
            { header: 'Remarks',                  key: 'remarks',           width: 30 },
            { header: 'Status',                   key: 'status',            width: 12 }
        ];
        wsG.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = orangeHeaderStyle; });
        wsG.views = [{ state: 'frozen', ySplit: 1 }];
        wsG.properties.defaultRowHeight = 60;

        permits.forEach(p => {
            const mats = materialsByPermit[p.permitNumber] || [];
            const sec = securityByPermit[p.permitNumber] || [];
            const cont = contractorsByPermit[p.permitNumber] || [];
            const appr = approvalsByPermit[p.permitNumber] || [];

            const securityGuardName = sec.length
                ? sec.map(s => s.officerName).join(', ')
                : '';

            const companyCharge = p.companyName
                ? p.companyName + ' (' + p.type + ')'
                : p.type;

            const responsiblePerson = cont.length
                ? cont.map(cr => cr.contractorId + ' - ' + cr.reason).join(', ')
                : (appr.length ? appr.map(a => a.approverName + ' (' + a.divisionName + ')').join(', ') : '');

            const materialDesc = mats.length
                ? mats.map(m => m.description).join(', ')
                : '';

            const quantity = mats.length
                ? mats.reduce((s, m) => s + (m.quantity || 0), 0).toString()
                : '';

            const purpose = cont.length
                ? cont.map(cr => cr.reason).join(', ')
                : (p.substance || '');

            const isReturnable = cont.some(cr => cr.returnable);

            let evidence = '';
            if (p.type === 'IN' && isReturnable) evidence = 'Returnable IN';
            else if (p.type === 'OUT' && isReturnable) evidence = 'Returnable OUT';
            else if (p.type === 'OUT' && !isReturnable) evidence = 'Non-returnable OUT';
            else evidence = p.type;

            const remarks = sec.length
                ? sec.map(s => s.remarks || '').filter(Boolean).join(', ')
                : '';

            const statusDisplay = p.status === 'closed' ? 'CLOSED' : 'OPEN';

            const row = wsG.addRow({
                date: p.permitDate,
                permitNumber: p.permitNumber,
                securityGuard: securityGuardName,
                companyCharge: companyCharge,
                responsiblePerson: responsiblePerson,
                materialDesc: materialDesc,
                quantity: quantity,
                purpose: purpose,
                inOut: p.type,
                toBeReturned: isReturnable ? 'Yes' : 'No',
                evidence: evidence,
                expectedReturn: '',
                actualReturn: '',
                returnedQty: '',
                remarks: remarks,
                status: statusDisplay
            });

            row.eachCell({ includeEmpty: true }, c => {
                c.border = cellBorder;
                c.alignment = { vertical: 'middle', wrapText: true };
            });

            row.getCell('permitNumber').font = { bold: true };

            // STATUS: CLOSED=green, OPEN=red
            const statusCell = row.getCell('status');
            statusCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            statusCell.alignment = { vertical: 'middle', horizontal: 'center' };
            if (p.status === 'closed') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28A745' } };
            } else {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC3545' } };
            }

            // IN/OUT badge
            const inOutCell = row.getCell('inOut');
            inOutCell.font = { bold: true };
            inOutCell.alignment = { vertical: 'middle', horizontal: 'center' };
            inOutCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: p.type === 'IN' ? 'FFD1E7DD' : 'FFFFF3CD' } };

            // To be returned badge
            const retCell = row.getCell('toBeReturned');
            retCell.font = { bold: true };
            retCell.alignment = { vertical: 'middle', horizontal: 'center' };
            if (isReturnable) {
                retCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1E7DD' } };
            }
        });
        if (!permits.length) {
            wsG.addRow().eachCell({ includeEmpty: true }, c => c.border = cellBorder);
        }

        // ===== SHEET 2: PERMITS =====
        const wsP = wb.addWorksheet('Permits');
        wsP.columns = [
            { header: 'Permit #', key: 'permitNumber', width: 16 },
            { header: 'Date', key: 'permitDate', width: 14 },
            { header: 'Company', key: 'companyName', width: 25 },
            { header: 'Address', key: 'companyAddress', width: 30 },
            { header: 'Destination', key: 'substance', width: 20 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Status', key: 'status', width: 14 },
            { header: 'Closed Date', key: 'closedDate', width: 20 }
        ];
        wsP.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsP.views = [{ state: 'frozen', ySplit: 1 }];

        permits.forEach(p => {
            const row = wsP.addRow({
                permitNumber: p.permitNumber,
                permitDate: p.permitDate,
                companyName: p.companyName,
                companyAddress: p.companyAddress,
                substance: p.substance || 'N/A',
                type: p.type,
                status: p.status,
                closedDate: (p.status === 'closed' && p.updatedAt)
                    ? new Date(p.updatedAt).toLocaleString() : 'Open'
            });
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
            // STATUS COLOR: closed = red, open = green
            const statusCell = row.getCell('status');
            statusCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            if (p.status === 'closed') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC3545' } };
            } else {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28A745' } };
            }
            statusCell.alignment = { vertical: 'middle', horizontal: 'center' };
            const typeCell = row.getCell('type');
            typeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: p.type === 'IN' ? 'FFD1E7DD' : 'FFFFF3CD' } };
            typeCell.font = { bold: true };
            typeCell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        // ===== SHEET 3: MATERIALS (avec photos) =====
        const wsM = wb.addWorksheet('Materials');
        wsM.columns = [
            { header: 'Equipment', key: 'equipmentNo', width: 14 },
            { header: 'Permit #', key: 'permitNumber', width: 16 },
            { header: 'Description', key: 'description', width: 28 },
            { header: 'Qty', key: 'quantity', width: 8 },
            { header: 'Unit Wt (kg)', key: 'unitWeight', width: 14 },
            { header: 'Weight (kg)', key: 'weight', width: 14 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Photo', key: 'photo', width: 14 }
        ];
        wsM.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsM.views = [{ state: 'frozen', ySplit: 1 }];
        wsM.properties.defaultRowHeight = 60;

        materials.forEach(m => {
            const row = wsM.addRow({
                equipmentNo: m.equipmentNo,
                permitNumber: m.permitNumber,
                description: m.description,
                quantity: m.quantity,
                unitWeight: m.unitWeight,
                weight: m.weight,
                type: m.type,
                photo: m.photo ? 'Y' : 'N'
            });
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
            row.getCell('type').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: m.type === 'IN' ? 'FFD1E7DD' : 'FFFFF3CD' } };
            row.getCell('type').font = { bold: true };
            row.getCell('type').alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell('photo').font = { bold: true, color: { argb: m.photo ? 'FF28A745' : 'FF999999' } };
            row.getCell('photo').alignment = { vertical: 'middle', horizontal: 'center' };

            // Embed photo inside the cell
            if (m.photo) {
                const fullPath = path.join(__dirname, m.photo);
                if (fs.existsSync(fullPath)) {
                    try {
                        const ext = (path.extname(m.photo) || '.png').replace('.', '').toLowerCase();
                        const imageId = wb.addImage({ filename: fullPath, extension: ext });
                        wsM.addImage(imageId, {
                            tl: { col: 7, row: row.number - 1, natCol: 7, natRow: row.number - 1 },
                            ext: { width: 50, height: 50 }
                        });
                        wsM.getCell('H' + row.number).value = '';
                    } catch (e) { /* image embedding failed, keep 'Y' text */ }
                }
            }
        });

        // ===== SHEET 3: TRANSPORTS =====
        const wsT = wb.addWorksheet('Transports');
        wsT.columns = [
            { header: 'Driver', key: 'driverName', width: 22 },
            { header: 'Vehicle Plate', key: 'vehiclePlate', width: 16 },
            { header: 'Date/Time', key: 'dateTime', width: 20 },
            { header: 'Permit #', key: 'permitNumber', width: 16 }
        ];
        wsT.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsT.views = [{ state: 'frozen', ySplit: 1 }];
        transports.forEach(t => {
            const row = wsT.addRow(t);
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
        });

        // ===== SHEET 4: SECURITY =====
        const wsS = wb.addWorksheet('Security');
        wsS.columns = [
            { header: 'Officer', key: 'officerName', width: 20 },
            { header: 'Date/Time', key: 'dateTime', width: 20 },
            { header: 'Remarks', key: 'remarks', width: 30 },
            { header: 'Signature', key: 'signature', width: 12 },
            { header: 'Permit #', key: 'permitNumber', width: 16 }
        ];
        wsS.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsS.views = [{ state: 'frozen', ySplit: 1 }];
        security.forEach(s => {
            const row = wsS.addRow({
                officerName: s.officerName,
                dateTime: s.dateTime ? new Date(s.dateTime).toLocaleString() : '',
                remarks: s.remarks || '',
                signature: s.signature ? 'Signed' : 'Pending',
                permitNumber: s.permitNumber
            });
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
        });

        // ===== SHEET 5: CONTRACTORS =====
        const wsC = wb.addWorksheet('Contractors');
        wsC.columns = [
            { header: 'Contractor ID', key: 'contractorId', width: 16 },
            { header: 'Reason', key: 'reason', width: 25 },
            { header: 'Reference', key: 'referenceNumber', width: 16 },
            { header: 'Returnable', key: 'returnable', width: 12 },
            { header: 'Signature', key: 'signature', width: 12 },
            { header: 'Permit #', key: 'permitNumber', width: 16 }
        ];
        wsC.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsC.views = [{ state: 'frozen', ySplit: 1 }];
        contractors.forEach(cr => {
            const row = wsC.addRow({
                contractorId: cr.contractorId,
                reason: cr.reason,
                referenceNumber: cr.referenceNumber || '',
                returnable: cr.returnable ? 'Yes' : 'No',
                signature: cr.signature ? 'Signed' : 'Pending',
                permitNumber: cr.permitNumber
            });
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
        });

        // ===== SHEET 6: APPROVALS =====
        const wsA = wb.addWorksheet('Approvals');
        wsA.columns = [
            { header: 'Approval ID', key: 'approvalId', width: 16 },
            { header: 'Division', key: 'divisionName', width: 22 },
            { header: 'Approver', key: 'approverName', width: 22 },
            { header: 'Signature', key: 'signature', width: 12 },
            { header: 'Permit #', key: 'permitNumber', width: 16 }
        ];
        wsA.getRow(1).eachCell({ includeEmpty: true }, c => { c.style = xlsxHeaderStyle; });
        wsA.views = [{ state: 'frozen', ySplit: 1 }];
        approvals.forEach(a => {
            const row = wsA.addRow({
                approvalId: a.approvalId,
                divisionName: a.divisionName,
                approverName: a.approverName,
                signature: a.signature ? 'Signed' : 'Pending',
                permitNumber: a.permitNumber
            });
            row.eachCell({ includeEmpty: true }, c => c.border = xlsxCellBorder);
        });

        const fileName = `ACWA_Permits_${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Excel export error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// =============================================
// API - TRANSPORTS
// =============================================
app.get('/api/transports', (req, res) => {
    db.query(`SELECT id, name_id AS driverName, vehicle_plate AS vehiclePlate, date_time AS dateTime,
              permit_number AS permitNumber, created_at AS createdAt
              FROM transports ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/transports', (req, res) => {
    const { driverName, vehiclePlate, dateTime, permitNumber } = req.body;
    const dbDateTime = dateTime ? dateTime.replace('T', ' ') + (dateTime.length === 16 ? ':00' : '') : null;
    db.query(
        `INSERT INTO transports (name_id, vehicle_plate, date_time, permit_number) VALUES (?, ?, ?, ?)`,
        [driverName, vehiclePlate, dbDateTime, permitNumber],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                    return res.status(400).json({ success: false, error: 'Permis introuvable: créez d\'abord le permis ' + permitNumber });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Transport created', id: result.insertId });
        }
    );
});

app.delete('/api/transports/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM transports WHERE id = ?', [id], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Transport deleted' });
    });
});

// =============================================
// API - SECURITY
// =============================================
app.get('/api/security', (req, res) => {
    db.query(`SELECT id, name_id AS officerName, date_time AS dateTime, remark AS remarks,
              signature_status AS signature, permit_number AS permitNumber, created_at AS createdAt
              FROM security_checks ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/security', (req, res) => {
    const { officerName, dateTime, remarks, signature, permitNumber } = req.body;
    const dbDateTime = dateTime ? dateTime.replace('T', ' ') + (dateTime.length === 16 ? ':00' : '') : null;
    db.query(
        `INSERT INTO security_checks (name_id, date_time, remark, signature_status, permit_number) VALUES (?, ?, ?, ?, ?)`,
        [officerName, dbDateTime, remarks, signature ? 1 : 0, permitNumber],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                    return res.status(400).json({ success: false, error: 'Permis introuvable: créez d\'abord le permis ' + permitNumber });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Security check created', id: result.insertId });
        }
    );
});

app.delete('/api/security/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM security_checks WHERE id = ?', [id], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Security check deleted' });
    });
});

// =============================================
// API - CONTRACTORS
// =============================================
app.get('/api/contractors', (req, res) => {
    db.query(`SELECT id, contractor_id AS contractorId, reason, reference_number AS referenceNumber,
              is_returnable AS returnable, signature_status AS signature, permit_number AS permitNumber,
              created_at AS createdAt
              FROM contractor_details ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/contractors', (req, res) => {
    const { contractorId, reason, referenceNumber, returnable, signature, permitNumber } = req.body;
    db.query(
        `INSERT INTO contractor_details (contractor_id, reason, reference_number, is_returnable, signature_status, permit_number) VALUES (?, ?, ?, ?, ?, ?)`,
        [contractorId, reason, referenceNumber || null, returnable ? 1 : 0, signature ? 1 : 0, permitNumber],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                    return res.status(400).json({ success: false, error: 'Permis introuvable: créez d\'abord le permis ' + permitNumber });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Contractor created', id: result.insertId });
        }
    );
});

app.delete('/api/contractors/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM contractor_details WHERE id = ?', [id], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Contractor deleted' });
    });
});

// =============================================
// API - APPROVALS
// =============================================
app.get('/api/approvals', (req, res) => {
    db.query(`SELECT id, approval_id AS approvalId, division_name AS divisionName,
              approver_name AS approverName, signature_status AS signature,
              permit_number AS permitNumber, created_at AS createdAt
              FROM approvals ORDER BY created_at DESC`, (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/approvals', (req, res) => {
    const { approvalId, divisionName, approverName, signature, permitNumber } = req.body;
    db.query(
        `INSERT INTO approvals (approval_id, division_name, approver_name, signature_status, permit_number) VALUES (?, ?, ?, ?, ?)`,
        [approvalId, divisionName, approverName, signature ? 1 : 0, permitNumber],
        (err, result) => {
            if (err) {
                if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                    return res.status(400).json({ success: false, error: 'Permis introuvable: créez d\'abord le permis ' + permitNumber });
                }
                res.status(500).json({ success: false, error: err.message });
                return;
            }
            res.json({ success: true, message: 'Approval created', id: result.insertId });
        }
    );
});

app.delete('/api/approvals/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM approvals WHERE id = ?', [id], (err, result) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json({ success: true, message: 'Approval deleted' });
    });
});

// =============================================
// API - PDF HISTORY (enregistré dans MySQL)
// =============================================
app.get('/api/pdf-history', (req, res) => {
    db.query('SELECT id, file_name AS fileName, type, permit_number AS permitNumber, created_at AS date FROM pdf_history ORDER BY created_at DESC', (err, results) => {
        if (err) { res.status(500).json({ error: err.message }); return; }
        res.json(results);
    });
});

app.post('/api/pdf-history', (req, res) => {
    const { fileName, type, permitNumber } = req.body;
    db.query(
        'INSERT INTO pdf_history (file_name, type, permit_number) VALUES (?, ?, ?)',
        [fileName, type || 'PDF', permitNumber || null],
        (err, result) => {
            if (err) { res.status(500).json({ success: false, error: err.message }); return; }
            res.json({ success: true, message: 'PDF history saved', id: result.insertId });
        }
    );
});

app.delete('/api/pdf-history/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM pdf_history WHERE id = ?', [id], (err) => {
        if (err) { res.status(500).json({ success: false, error: err.message }); return; }
        res.json({ success: true, message: 'PDF history deleted' });
    });
});

// =============================================
// GET LOCAL IP
// =============================================
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let name of Object.keys(interfaces)) {
        for (let iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// =============================================
// START
// =============================================
app.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`\n🚀 ========================================`);
    console.log(`🚀 ACWA Operations Server`);
    console.log(`🚀 ========================================`);
    console.log(`📱 Local : http://localhost:${PORT}/login.html`);
    console.log(`📱 Réseau local : http://${ip}:${PORT}/login.html`);
    
    console.log(`🚀 ========================================\n`);
});