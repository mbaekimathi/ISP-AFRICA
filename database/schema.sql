CREATE DATABASE IF NOT EXISTS `ISP-DB`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `ISP-DB`;

CREATE TABLE IF NOT EXISTS isp_clients (
  id CHAR(36) NOT NULL PRIMARY KEY,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  username VARCHAR(24) NOT NULL,
  email VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  login_code CHAR(6) NOT NULL,
  password_salt CHAR(32) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  photo_data_url MEDIUMTEXT NULL,
  status ENUM('pending', 'approved') NOT NULL DEFAULT 'pending',
  client_code VARCHAR(16) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_username (username),
  UNIQUE KEY uq_client_email (email),
  UNIQUE KEY uq_client_phone (phone),
  UNIQUE KEY uq_client_login_code (login_code)
);

CREATE TABLE IF NOT EXISTS isp_employees (
  id CHAR(36) NOT NULL PRIMARY KEY,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  username VARCHAR(24) NOT NULL,
  email VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  login_code CHAR(6) NOT NULL,
  password_salt CHAR(32) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  photo_data_url MEDIUMTEXT NULL,
  status ENUM('pending', 'approved') NOT NULL DEFAULT 'pending',
  employee_code VARCHAR(16) NULL,
  role ENUM(
    'director',
    'supervisor',
    'customer-care',
    'technician',
    'it-support',
    'dispatcher',
    'sales'
  ) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employee_username (username),
  UNIQUE KEY uq_employee_email (email),
  UNIQUE KEY uq_employee_phone (phone),
  UNIQUE KEY uq_employee_login_code (login_code)
);

CREATE TABLE IF NOT EXISTS isp_client_employees (
  id CHAR(36) NOT NULL PRIMARY KEY,
  client_id CHAR(36) NOT NULL,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  title VARCHAR(60) NOT NULL DEFAULT '',
  email VARCHAR(120) NOT NULL DEFAULT '',
  phone VARCHAR(20) NOT NULL DEFAULT '',
  login_code CHAR(6) NOT NULL,
  password_salt CHAR(32) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  photo_data_url MEDIUMTEXT NULL,
  status ENUM('pending', 'active', 'suspended') NOT NULL DEFAULT 'pending',
  role ENUM('isp-technician', 'isp-customercare', 'isp-manager') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_isp_employee_login (login_code),
  UNIQUE KEY uq_isp_employee_name (client_id, first_name, last_name),
  KEY idx_isp_employee_client (client_id)
);
