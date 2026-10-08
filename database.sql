-- =============================================
-- BASE DE DONNÉES : noor_inventory
-- =============================================

CREATE DATABASE IF NOT EXISTS noor_inventory;
USE noor_inventory;

-- =============================================
-- TABLE : users
-- =============================================
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
);

-- =============================================
-- TABLE : permit_details
-- =============================================
CREATE TABLE IF NOT EXISTS permit_details (
    permit_number VARCHAR(20) PRIMARY KEY,
    permit_date DATE NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    company_address VARCHAR(255) NOT NULL,
    substance_destination VARCHAR(255),
    type ENUM('IN', 'OUT') DEFAULT 'IN',
    status ENUM('pending', 'approved', 'returnable', 'closed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- =============================================
-- TABLE : materials
-- =============================================
CREATE TABLE IF NOT EXISTS materials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    equipment_no VARCHAR(50) NOT NULL,
    permit_number VARCHAR(20) NOT NULL,
    description VARCHAR(255) NOT NULL,
    quantity INT NOT NULL,
    unit_weight DECIMAL(10,2) NOT NULL,
    weight DECIMAL(10,2) NOT NULL,
    movement_type ENUM('IN', 'OUT') NOT NULL,
    photo VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (permit_number) REFERENCES permit_details(permit_number) ON DELETE CASCADE
);

-- =============================================
-- TABLE : transports
-- =============================================
CREATE TABLE IF NOT EXISTS transports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name_id VARCHAR(255) NOT NULL,
    vehicle_plate VARCHAR(50) NOT NULL,
    date_time DATETIME NOT NULL,
    permit_number VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (permit_number) REFERENCES permit_details(permit_number) ON DELETE CASCADE
);

-- =============================================
-- TABLE : security_checks
-- =============================================
CREATE TABLE IF NOT EXISTS security_checks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name_id VARCHAR(255) NOT NULL,
    date_time DATETIME NOT NULL,
    remark TEXT,
    signature_status BOOLEAN DEFAULT FALSE,
    permit_number VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (permit_number) REFERENCES permit_details(permit_number) ON DELETE CASCADE
);

-- =============================================
-- TABLE : contractor_details
-- =============================================
CREATE TABLE IF NOT EXISTS contractor_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contractor_id VARCHAR(50) NOT NULL,
    reason VARCHAR(255) NOT NULL,
    reference_number VARCHAR(50),
    is_returnable BOOLEAN DEFAULT FALSE,
    signature_status BOOLEAN DEFAULT FALSE,
    permit_number VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (permit_number) REFERENCES permit_details(permit_number) ON DELETE CASCADE
);

-- =============================================
-- TABLE : approvals
-- =============================================
CREATE TABLE IF NOT EXISTS approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    approval_id VARCHAR(50) NOT NULL,
    division_name VARCHAR(255) NOT NULL,
    approver_name VARCHAR(255) NOT NULL,
    signature_status BOOLEAN DEFAULT FALSE,
    permit_number VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (permit_number) REFERENCES permit_details(permit_number) ON DELETE CASCADE
);

-- =============================================
-- UTILISATEURS : aucun compte par défaut.
-- Le compte administrateur est créé au premier démarrage du serveur
-- (mot de passe issu de ADMIN_SEED_PASSWORD ou généré aléatoirement).
-- =============================================

-- =============================================
-- DONNÉES DE TEST
-- =============================================
INSERT IGNORE INTO permit_details (permit_number, permit_date, company_name, company_address, substance_destination, type, status) VALUES
('P-2026-001', '2026-08-01', 'ACWA Chemicals', '123 Industrial Zone, Casablanca', 'Warehouse A', 'OUT', 'approved'),
('P-2026-002', '2026-08-03', 'Noor Industries', '456 Business Park, Rabat', 'Storage B', 'IN', 'pending'),
('P-2026-003', '2026-08-05', 'Global Logistics', '789 Port Area, Tanger', 'Dock 3', 'OUT', 'returnable'),
('P-2026-004', '2026-08-07', 'Noor Trading', '321 Trade Center, Casablanca', 'Warehouse C', 'IN', 'closed');

INSERT IGNORE INTO materials (equipment_no, permit_number, description, quantity, unit_weight, weight, movement_type) VALUES
('EQ-001', 'P-2026-001', 'Sulfuric Acid', 10, 45.00, 450.00, 'OUT'),
('EQ-002', 'P-2026-002', 'Chlorine Gas', 5, 60.00, 300.00, 'IN'),
('EQ-003', 'P-2026-003', 'Caustic Soda', 8, 25.00, 200.00, 'OUT');