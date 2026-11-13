# Inventario Asaderos — Prototipo académico

Prototipo web de inventario por lotes para insumos perecederos, desarrollado como monografía de Ingeniería de Software con un asadero de Soacha, Cundinamarca, como caso de referencia. **La evaluación corresponde a pruebas técnicas locales y bases aisladas; no se reporta despliegue productivo, prueba piloto en el establecimiento ni reducción real de desperdicio.**

**Documento académico:** [Monografía – revisión editorial 9 (Word)](documentacion/Monografia_Inventario_Asaderos_Revision9_Cierre_Editorial_2026.docx).

## Funcionalidades implementadas

- Catálogo de productos y parámetros de reposición.
- Entradas de compras por lote con proveedor, fecha de vencimiento, cantidad y costo unitario.
- Salidas con rotación **FEFO** (*first expired, first out*, primero en vencer, primero en salir), con transacciones para conservar la consistencia. El archivo de implementación conserva el nombre histórico `peps.js`.
- Bloqueo de uso de lotes vencidos; los lotes que vencen hoy aún se consideran vigentes.
- Alertas por vencimiento, stock utilizable y sugerencias de reposición.
- Consulta de movimientos y presentación de reportes en la interfaz.
- Sesión JWT y acceso exclusivo al módulo de inventario para el rol `admin` en la versión evaluada. El registro público `/api/auth/register` devuelve HTTP 403.
- **Idempotencia de salidas:** una misma operación repetida con la misma cabecera `Idempotency-Key` no genera un nuevo descuento; reutilizar la clave con otra carga genera conflicto.

## Alcance y limitaciones

- Los vencidos **se excluyen del stock utilizable**, pero **no existe operación implementada para registrar su descarte físico**. La pantalla de merma no acredita una medición real del desperdicio.
- Las entradas no cuentan con el mismo control de idempotencia que las salidas.
- Las claves de idempotencia son globales; no se implementaron relación foránea con usuarios ni limpieza/caducidad automática.
- El esquema contiene el rol `encargado` por compatibilidad histórica, pero este rol no está autorizado a utilizar la API de inventario en la versión evaluada.
- No se han probado operaciones en producción ni efectos económicos en el establecimiento.

## Tecnologías

Frontend: React, Vite y JavaScript/JSX. Backend: Node.js, Express, MySQL 8, `mysql2`, JWT, `bcryptjs`. Pruebas unitarias con `node --test`.

## Estructura

```text
inventariokest/
  backend/
    src/                 API, lógica de lotes y utilidad de cuentas
    test/                pruebas unitarias
    schema.sql           esquema inicial y datos de ejemplo
    sql/01_solicitud_idempotente.sql
    P16*.js / P17*.js / P18*.js / P20*.js  ensayos de integración (si están incluidos)
    P18_H3_PRUEBA_AISLADA_AUTOMATICA.js   regresión H3/P18
  frontend/              interfaz de usuario
  docs/                  reproducibilidad y resultados
  documentacion/         monografía final
  README.md
```

## Instalación local básica

**Requisitos:** Node.js compatible (entorno de prueba Node.js 22), MySQL 8 y npm. Crear una base de **ensayo**, nunca importar el esquema sobre registros que deban conservarse.

```bash
git clone https://github.com/KestWard/inventariokest.git
cd inventariokest
mysql -u root -p < backend/schema.sql
mysql -u root -p < backend/sql/01_solicitud_idempotente.sql
cd backend
npm ci
cp .env.example .env
# Configurar backend/.env SOLO en el equipo local: claves y secreto JWT propios.
npm test
npm start
```

En otra terminal:

```bash
cd frontend
npm ci
npm run build
npm run dev
```

Abrir la URL indicada por Vite (habitualmente `http://localhost:5173`). La API local utiliza normalmente `http://localhost:3000`. Se requiere una cuenta `admin` de ensayo para iniciar sesión; se puede crear mediante la utilidad `backend/src/crear-usuario.js`, utilizando credenciales propias y sin publicar contraseñas.

## Pruebas y reproducibilidad

- Backend: `cd backend && npm test` (11 pruebas unitarias aprobadas en la evaluación documentada).
- Frontend: `cd frontend && npm run build`.
- Las pruebas de integración de P16, P17, P18 y P20 requieren bases MySQL de ensayo y preparación específica. **No ejecutar scripts sobre la base de trabajo** ni repetir P18 sobre una base que haya quedado con movimientos de una ejecución anterior.
- La verificación H3/P18 más reciente (13/11/2026) obtuvo 403 para registro, 401 sin token, 403 con rol `encargado`, 200 en login admin y 4/4 escenarios de idempotencia en base aislada. Resultados y condiciones: [documentación de reproducibilidad](docs/REPRODUCIBILIDAD.md).

## Naturaleza del proyecto

Código publicado exclusivamente con fines académicos. No representa una solución operativa implantada en el establecimiento.
