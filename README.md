<div align="center">

# 🍗 Inventario Asaderos

**Sistema web de control de inventario para asaderos de Soacha, con rotación PEPS, alertas de vencimiento y sugerencias de compra.**

![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?style=for-the-badge&logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8-4479A1?style=for-the-badge&logo=mysql&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-Auth-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white)

</div>

---

## 📖 Descripción

Inventario Asaderos es una aplicación web que ayuda a los asaderos a controlar sus existencias de insumos perecederos como pollo, papa, adobo y salsas. Reduce el desperdicio y evita quedarse sin producto.

El sistema registra cada compra como un lote con su fecha de vencimiento y descuenta las salidas con el criterio **PEPS** (primero en expirar, primero en salir). Siempre se usa primero el lote más próximo a vencer, y los lotes vencidos nunca se descuentan. Cada operación queda registrada con el usuario que la realizó, lo que da trazabilidad completa del inventario.

## ✨ Funcionalidades principales

- 📦 **Gestión de lotes y entradas:** registro de compras con proveedor, cantidad, costo unitario y fecha de vencimiento.
- 🔄 **Salidas con rotación PEPS:** el descuento se reparte automáticamente entre lotes, dentro de una transacción que evita inconsistencias cuando hay operaciones simultáneas.
- ⏰ **Alertas de vencimiento:** aviso de los lotes que vencen en los próximos dos días.
- 🛒 **Sugerencias de compra:** cálculo del punto de reorden a partir del consumo diario, el tiempo de entrega del proveedor y el stock mínimo, con la cantidad recomendada a comprar.
- 🗂️ **Catálogo de productos:** alta de productos con sus parámetros de reposición.
- 📊 **Reportes de movimientos:** historial de entradas y salidas de los últimos 30 días, con exportación a CSV e impresión en PDF.
- 🔐 **Autenticación segura:** inicio de sesión con JWT y contraseñas cifradas con bcrypt.

## 🛠️ Stack tecnológico

### Frontend

<p>
  <img src="https://skillicons.dev/icons?i=react,vite,js,html,css" alt="Frontend" />
</p>

| Tecnología | Uso |
|---|---|
| **React 18** | Interfaz de usuario (SPA) |
| **Vite 5** | Servidor de desarrollo y empaquetado |
| **JavaScript (JSX)** | Lenguaje de los componentes |
| **HTML5 / CSS3** | Estructura y estilos |

### Backend

<p>
  <img src="https://skillicons.dev/icons?i=nodejs,express,js" alt="Backend" />
</p>

| Tecnología | Uso |
|---|---|
| **Node.js** | Entorno de ejecución |
| **Express 5** | API REST |
| **mysql2** | Conexión a MySQL con consultas parametrizadas |
| **jsonwebtoken** | Sesiones con JWT |
| **bcryptjs** | Cifrado de contraseñas |
| **dotenv** | Variables de entorno |
| **cors** | Comunicación entre frontend y backend |

### Base de datos

<p>
  <img src="https://skillicons.dev/icons?i=mysql" alt="Base de datos" />
</p>

MySQL 8 con llaves foráneas, restricciones `CHECK` e índices para la consulta PEPS.

### Herramientas

<p>
  <img src="https://skillicons.dev/icons?i=git,github,npm,vscode" alt="Herramientas" />
</p>

Pruebas unitarias con el ejecutor nativo de Node.js (`node --test`).

## 🏗️ Arquitectura

```
inventariokest/
├── backend/
│   ├── src/
│   │   ├── server.js          # API REST y autenticación
│   │   ├── peps.js            # Lógica de negocio (funciones puras)
│   │   └── crear-usuario.js   # Script de creación de usuarios
│   ├── test/                  # Pruebas unitarias de la lógica PEPS
│   └── schema.sql             # Esquema y datos semilla
└── frontend/                  # Interfaz React (SPA)
```

La lógica de negocio está separada de la base de datos, por lo que se prueba sin necesidad de MySQL.

## 📋 Requisitos previos

- [Node.js](https://nodejs.org/) 18 o superior
- [MySQL](https://dev.mysql.com/downloads/) 8 (el esquema usa la collation `utf8mb4_0900_ai_ci`, que no existe en MariaDB)

## 🚀 Instalación

### 1. Clonar el repositorio

```bash
git clone <URL-DEL-REPOSITORIO>
cd inventariokest
```

### 2. Base de datos

```bash
mysql -u root -p < backend/schema.sql
```

Esto crea la base `asadero_inventario`, sus tablas y algunos productos y proveedores de ejemplo, editables desde la aplicación.

### 3. Backend

```bash
cd backend
npm install
```

Crea un archivo `backend/.env` con el siguiente contenido (ajusta los valores):

```env
DB_HOST=localhost
DB_USER=root
DB_PASS=tu_clave_de_mysql
DB_NAME=asadero_inventario
JWT_SECRET=una_clave_larga_y_aleatoria
PORT=3000
```

Crea el primer usuario administrador e inicia el servidor:

```bash
npm run crear-usuario -- "Nombre Apellido" correo@ejemplo.com clave_segura admin
npm start
```

La API quedará disponible en `http://localhost:3000`.

### 4. Frontend

En otra terminal:

```bash
cd frontend
npm install
npm run dev
```

Abre la dirección que muestra Vite (normalmente `http://localhost:5173`). El frontend redirige las llamadas `/api` al backend en el puerto 3000.

## 🧪 Pruebas

```bash
cd backend
npm test
```

Las pruebas cubren la lógica PEPS (reparto entre lotes, lotes vencidos, decimales), las validaciones de entrada, el punto de reorden y el manejo de transacciones con rollback.

## 👥 Usuarios y roles

| Rol | Cómo se crea |
|---|---|
| `admin` | Con el script `npm run crear-usuario` |
| `encargado` | Con el script o desde la pantalla de registro de la aplicación |

## 📐 Reglas de negocio

- **PEPS:** las salidas descuentan primero el lote que vence antes; ante igual fecha, el más antiguo.
- **Lote vencido:** un lote que vence hoy aún es utilizable; desde el día siguiente se excluye de las salidas y del stock vigente.
- **Punto de reorden:** `consumo diario × días de entrega + stock mínimo`.
- **Cantidad sugerida de compra:** `punto de reorden + 2 días de consumo − stock vigente` (mínimo 0).
- **Alerta de vencimiento:** lotes con stock que vencen en 2 días o menos.

## 📄 Licencia

Proyecto de uso académico y educativo. Define aquí la licencia que prefieras.
