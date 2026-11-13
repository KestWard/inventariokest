const mysql = require('mysql2/promise');

async function preparar() {
  const base = 'asadero_p18_0127fce1';

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: base
  });

  try {
    const [[resultado]] = await db.query(
      'SELECT DATABASE() AS nombre'
    );

    if (resultado.nombre !== base) {
      throw new Error('Base de datos incorrecta');
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS solicitud_idempotente (
        clave VARCHAR(64) NOT NULL PRIMARY KEY,
        usuario_id INT NOT NULL,
        huella CHAR(64) NOT NULL,
        respuesta JSON NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    console.log('TABLA P18 CREADA CORRECTAMENTE');
    console.log('Base de ensayo:', base);
    console.log('Inventario principal sin modificaciones');

  } finally {
    await db.end();
  }
}

preparar().catch(error => {
  console.error('ERROR P18:', error.message);
  process.exitCode = 1;
});