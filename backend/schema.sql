-- Sistema de control de inventario para asaderos de Soacha
-- MySQL 8. Ejecutar: mysql -u root -p < schema.sql
CREATE DATABASE IF NOT EXISTS asadero_inventario CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE asadero_inventario;

CREATE TABLE IF NOT EXISTS usuario (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  rol ENUM('admin','encargado') NOT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS proveedor (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  telefono VARCHAR(30) NULL,
  email VARCHAR(120) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS producto (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  unidad VARCHAR(20) NOT NULL,                       -- kg, und, lt...
  consumo_diario DECIMAL(10,2) NOT NULL DEFAULT 0,   -- editable por el admin
  dias_entrega INT UNSIGNED NOT NULL DEFAULT 1,      -- tiempo de entrega del proveedor
  stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 0,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  CHECK (consumo_diario >= 0 AND stock_minimo >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lote (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  producto_id INT UNSIGNED NOT NULL,
  proveedor_id INT UNSIGNED NOT NULL,
  cantidad_inicial DECIMAL(10,2) NOT NULL,
  cantidad_actual DECIMAL(10,2) NOT NULL,
  costo_unitario DECIMAL(12,2) NOT NULL,
  fecha_ingreso DATE NOT NULL,
  fecha_vencimiento DATE NOT NULL,
  CONSTRAINT fk_lote_producto  FOREIGN KEY (producto_id)  REFERENCES producto(id),
  CONSTRAINT fk_lote_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedor(id),
  CHECK (cantidad_inicial > 0 AND cantidad_actual >= 0 AND cantidad_actual <= cantidad_inicial),
  INDEX idx_lote_peps (producto_id, fecha_vencimiento)  -- acelera la consulta PEPS
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS movimiento (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tipo ENUM('E','S','M') NOT NULL,                   -- E entrada, S salida, M merma
  lote_id INT UNSIGNED NOT NULL,
  producto_id INT UNSIGNED NOT NULL,
  usuario_id INT UNSIGNED NOT NULL,
  cantidad DECIMAL(10,2) NOT NULL,
  fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  observacion VARCHAR(255) NULL,
  CONSTRAINT fk_mov_lote     FOREIGN KEY (lote_id)     REFERENCES lote(id),
  CONSTRAINT fk_mov_producto FOREIGN KEY (producto_id) REFERENCES producto(id),
  CONSTRAINT fk_mov_usuario  FOREIGN KEY (usuario_id)  REFERENCES usuario(id),
  CHECK (cantidad > 0),
  INDEX idx_mov_fecha (fecha, tipo)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alerta (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tipo ENUM('VENCIMIENTO','REORDEN') NOT NULL,
  producto_id INT UNSIGNED NOT NULL,
  lote_id INT UNSIGNED NULL,
  mensaje VARCHAR(255) NOT NULL,
  fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atendida TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_alerta_producto FOREIGN KEY (producto_id) REFERENCES producto(id),
  CONSTRAINT fk_alerta_lote     FOREIGN KEY (lote_id)     REFERENCES lote(id)
) ENGINE=InnoDB;

-- Datos semilla: valores de EJEMPLO, editables desde la pantalla de productos.
INSERT INTO proveedor (nombre, telefono) VALUES
  ('Proveedor Avícola (ejemplo)', NULL),
  ('Distribuidor de Abarrotes (ejemplo)', NULL);

INSERT INTO producto (nombre, unidad, consumo_diario, dias_entrega, stock_minimo) VALUES
  ('Pollo crudo', 'kg', 30.00, 1, 10.00),
  ('Papa',        'kg', 20.00, 2, 8.00),
  ('Adobo',       'kg',  1.00, 3, 1.00),
  ('Salsas',      'lt',  3.00, 3, 2.00);
-- Los usuarios se crean con un script que hashea la contraseña con bcryptjs (fase API).
