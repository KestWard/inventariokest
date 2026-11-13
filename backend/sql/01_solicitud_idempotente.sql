-- Esquema auxiliar para claves de idempotencia en salidas FEFO.
-- Ejecutar SOLO en una base de ensayo nueva, tras backend/schema.sql.
-- No es un comando de limpieza ni debe ejecutarse en bases con datos sin revisar.
USE asadero_inventario;
CREATE TABLE IF NOT EXISTS solicitud_idempotente (
  clave VARCHAR(64) NOT NULL PRIMARY KEY,
  usuario_id INT NOT NULL,
  huella CHAR(64) NOT NULL,
  respuesta JSON NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
