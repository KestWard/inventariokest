-- Desactiva las cuentas de ensayo con rol 'encargado' (el rol no tiene acceso a la API).
-- No las borra: los movimientos conservan su usuario_id (llave foránea).
-- Revise primero la lista y ejecute solo sobre la base que corresponda.
USE asadero_inventario;

-- 1. Cuentas que se van a desactivar:
SELECT id, nombre, email, rol, activo FROM usuario WHERE rol = 'encargado';

-- 2. Desactivación:
UPDATE usuario SET activo = 0 WHERE rol = 'encargado';

-- 3. Verificación (debe mostrar activo = 0 en todas):
SELECT id, email, rol, activo FROM usuario ORDER BY rol, id;
