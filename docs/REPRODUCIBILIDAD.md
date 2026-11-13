# Reproducibilidad y alcance de las pruebas

Documento complementario del repositorio de la monografía **Inventario Asaderos**, 13/11/2026. Los resultados citados corresponden a capturas y registros de ensayos locales del autor; la publicación del repositorio no implica que un tercero haya repetido las pruebas.

## Requisitos previos

- Node.js 22 (versión utilizada en la sesión registrada) y dependencias de `package-lock.json` instaladas mediante `npm ci`.
- MySQL 8 en un entorno local controlado. Configurar `backend/.env` desde `backend/.env.example`; no versionarlo.
- Para la instalación ordinaria desde cero, ejecutar `backend/schema.sql` y después `backend/sql/01_solicitud_idempotente.sql` sobre una base local nueva de ejemplo. Leer antes de ejecutar: el esquema crea la base `asadero_inventario`.
- Crear el usuario administrador de prueba utilizando `backend/src/crear-usuario.js` con credenciales privadas del evaluador.

## Pruebas de ejecución inmediata

Desde Git Bash:

```bash
cd backend
npm ci
node --check src/server.js
node --check src/peps.js
npm test
cd ../frontend
npm ci
npm run build
```

La comprobación local documentada informó **11/11 pruebas unitarias** superadas. El resultado de compilación del frontend fue satisfactorio en la sesión del autor.

## Ensayos de integración: preparación estrictamente aislada

Los scripts `P16_*.js`, `P17_*.js`, `P18_*.js` y `P20_*.js` se conservaron como evidencia del proceso técnico. Algunos crean bases propias, utilizan nombres de base fijos, o registran operaciones de ensayo. **Leer cada script antes de ejecutarlo.** No se debe señalar que todos son reproducibles automáticamente con un comando único.

La regresión complementaria `backend/P18_H3_PRUEBA_AISLADA_AUTOMATICA.js` requiere:

1. Base aislada llamada `asadero_h3_p18_final_20261113`, con estructura compatible y tabla `solicitud_idempotente`.
2. Usuario `admin.p18@pruebas.local` con rol `admin` y contraseña configurada localmente en `P18_TEST_PASSWORD`. El archivo de contraseña no se publica.
3. Producto de ensayo `Producto Ensayo P18` con **un lote vigente de 5 kg**, sin movimientos para ese producto ni claves de idempotencia previas.
4. Puerto temporal `3018` disponible. El script impide continuar si no se cumplen las precondiciones principales.

Si la base queda parcialmente modificada tras un fallo, **no repetir la prueba sin inspeccionar primero los registros y el stock**. La base de ensayo no es una base de producción.

## Resultados documentados el 13/11/2026

Autorización (H3): registro público HTTP **403**; API sin token HTTP **401**; token con rol `encargado` HTTP **403**; login administrador HTTP **200**.

Idempotencia (P18), **4/4 escenarios correctos**:

| Escenario | Resultado |
| --- | --- |
| Reintento idéntico | HTTP 200/200, stock 5 a 4, un movimiento |
| Nueva operación independiente | HTTP 200, stock 4 a 3, dos movimientos acumulados |
| Mismo identificador con otro contenido | HTTP 409, stock permanece en 3 |
| Dos peticiones simultáneas con la misma clave | HTTP 200/200, stock 3 a 2, tres movimientos totales |

El resultado conjunto fue **stock 5 a 2 kg, 3 movimientos y 3 claves registradas**, con cierre del servidor temporal. El archivo generado localmente se denomina `backend/P18_H3_resultados_verificacion_final.txt` y debe estar incluido si se desea revisar el registro textual exacto. La monografía contiene la captura original correspondiente.

## Otras pruebas presentes en la monografía

- **P16:** comprobaciones transaccionales de rollback/commit documentadas en entorno aislado.
- **P17:** 50/50 casos de concurrencia, y 50/50 casos adicionales de regresión; corresponden a dos series de prueba.
- **P20:** corrida de 30 entradas y 30 salidas, 60 operaciones HTTP satisfactorias en el entorno de prueba. P95 de entradas **9,02 ms** y de salidas **11,26 ms**. El ensayo histórico de 30 consultas GET es distinto y no debe mezclarse con los 60 POST.

## Límites de las conclusiones

Los ensayos no demuestran puesta en producción, uso por personal del establecimiento, medición de ahorro, ni registro de descarte físico. La autorización exclusiva y la idempotencia fueron confirmadas **en la versión local evaluada**, siempre que el repositorio corresponda exactamente a esa versión. Documentar el identificador del commit publicado en el acta o versión de entrega de la monografía.
