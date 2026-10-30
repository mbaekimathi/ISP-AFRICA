import hashlib
import os
import secrets
import sys
import uuid

import pymysql

import envfile

envfile.load()

PASSWORD = "".join(secrets.choice("0123456789") for _ in range(6))
SALT = secrets.token_bytes(16)
ITERATIONS = 210_000
PASSWORD_HASH = "pbkdf2$%d$%s" % (
    ITERATIONS,
    hashlib.pbkdf2_hmac("sha256", PASSWORD.encode(), SALT, ITERATIONS).hex(),
)
SALT_HEX = SALT.hex()

SCHEMA = """
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
"""


def connect(database=None):
    return pymysql.connect(
        host=os.environ.get("ISP_DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("ISP_DB_PORT", "3306")),
        user=os.environ.get("ISP_DB_USER", "root"),
        password=os.environ.get("ISP_DB_PASSWORD", ""),
        database=database,
        charset="utf8mb4",
        autocommit=True,
    )


def main():
    db_name = os.environ.get("ISP_DB_NAME", "ISP-DB")
    server = connect()
    with server.cursor() as cursor:
        cursor.execute(
            f"CREATE DATABASE IF NOT EXISTS `{db_name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
    server.close()

    db = connect(db_name)
    with db.cursor() as cursor:
        for statement in SCHEMA.split(";"):
            sql = statement.strip()
            if sql:
                cursor.execute(sql)
        # INSERT IGNORE: on an existing install the demo accounts must keep the
        # password the operator set — never reset them to a new random one.
        fresh = False
        cursor.execute(
            """
            INSERT IGNORE INTO isp_clients (
              id, first_name, last_name, username, email, phone, login_code,
              password_salt, password_hash, status, client_code
            ) VALUES (%s, 'ISP', 'Client', 'ispclient', 'isp.client@localhost', '0700000000', '000000', %s, %s, 'approved', 'IC-00000001')
            """,
            (str(uuid.uuid5(uuid.NAMESPACE_DNS, "isp-client-000000")), SALT_HEX, PASSWORD_HASH),
        )
        fresh = fresh or cursor.rowcount > 0
        cursor.execute(
            """
            INSERT IGNORE INTO isp_employees (
              id, first_name, last_name, username, email, phone, login_code,
              password_salt, password_hash, status, employee_code, role
            ) VALUES (%s, 'ISP', 'Employee', 'ispemployee', 'isp.employee@localhost', '0700000001', '000000', %s, %s, 'approved', 'EM-00000001', 'director')
            """,
            (str(uuid.uuid5(uuid.NAMESPACE_DNS, "isp-employee-000000")), SALT_HEX, PASSWORD_HASH),
        )
        fresh = fresh or cursor.rowcount > 0
        cursor.execute(
            """
            SELECT 'client' AS account_type, login_code, status, client_code AS code FROM isp_clients
            UNION ALL
            SELECT 'employee', login_code, status, employee_code FROM isp_employees
            """
        )
        rows = cursor.fetchall()
    db.close()
    for row in rows:
        print("\t".join(str(part) for part in row))
    if fresh:
        print(f"seeded password for both accounts: {PASSWORD} (sign in once, then change it)")
    else:
        print("demo accounts already exist — existing passwords were left unchanged")


if __name__ == "__main__":
    try:
        main()
    except pymysql.MySQLError as error:
        print(f"PyMySQL could not reach MySQL: {error}", file=sys.stderr)
        sys.exit(1)
