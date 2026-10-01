import fs from 'fs';
import path from 'path';
import { ordenesVentaEmitirFE } from '../data/curated/endpoints/ordenesventa-emitirFE.js';
import { ordenesVentaSearch } from '../data/curated/endpoints/ordenesVenta-search.js';
import { ordenesVentaGetById } from '../data/curated/endpoints/ordenesVenta-GetById.js';

const DEV_FILE = 'C:/Users/Usuario/Downloads/API Contabilium_dev2.postman_collection';
const BACKUP_FILE = 'C:/Users/Usuario/Downloads/API Contabilium_dev2.postman_collection.bak';

const EXPECTED_DEV_ID = '9d9239f3-b48f-4dbe-9bc4-02c1419b95ec';
const FORBIDDEN_MAIN_ID = '2e6d2216-9afc-4874-8cbd-91ff36a1d511';

if (!fs.existsSync(DEV_FILE)) {
  console.error(`❌ No se encontró el archivo: ${DEV_FILE}`);
  process.exit(1);
}

const rawContent = fs.readFileSync(DEV_FILE, 'utf8');
const collection = JSON.parse(rawContent);

// 1. BLINDAJE DE SEGURIDAD ESTRICTO POR ID
console.log('🔒 Verificando seguridad de IDs...');
console.log(`   ID detectado en archivo: ${collection.info?._postman_id}`);

if (collection.info?._postman_id === FORBIDDEN_MAIN_ID) {
  console.error('⛔ ERROR CRÍTICO: El archivo corresponde a MAIN (2e6d2216-...). Operación abortada.');
  process.exit(1);
}

if (collection.info?._postman_id !== EXPECTED_DEV_ID) {
  console.error(`⛔ ERROR: El ID no coincide con DEV2 (${EXPECTED_DEV_ID}). Operación abortada.`);
  process.exit(1);
}

console.log('✅ Verificación de ID exitosa: El archivo es inequívocamente DEV2.');

// 2. Respaldo de seguridad
fs.writeFileSync(BACKUP_FILE, rawContent, 'utf8');
console.log(`📦 Respaldo de seguridad creado en: ${BACKUP_FILE}`);

const patches = [
  ordenesVentaEmitirFE,
  ordenesVentaSearch,
  ordenesVentaGetById
];

let modifiedCount = 0;
let totalRequests = 0;
const report = [];

function findAndPatch(items, currentPath = []) {
  for (const it of items) {
    const itemPath = [...currentPath, it.name];
    if (it.request) {
      totalRequests++;
      const urlRaw = typeof it.request.url === 'string' ? it.request.url : (it.request.url?.raw || '');
      
      const patch = patches.find(p => {
        const pathMatches = p.targetPath && p.targetPath.join(' > ') === itemPath.join(' > ');
        const urlMatches = p.urlMatch && urlRaw.includes(p.urlMatch);
        return pathMatches || urlMatches;
      });

      if (patch) {
        it.request.description = patch.description;
        if (patch.queryParams && it.request.url?.query) {
          for (const pq of patch.queryParams) {
            const existingQ = it.request.url.query.find(q => q.key === pq.key);
            if (existingQ) {
              existingQ.description = pq.description;
            } else {
              it.request.url.query.push(pq);
            }
          }
        }
        if (patch.responses) {
          it.response = patch.responses;
        }
        modifiedCount++;
        report.push({
          status: 'MODIFICADO',
          endpoint: `${it.request.method} ${urlRaw}`,
          path: itemPath.join(' > '),
          detalles: `Descripción enriquecida, parámetros saneados y ${patch.responses?.length || 0} ejemplos guardados.`
        });
      }
    }
    if (it.item) {
      findAndPatch(it.item, itemPath);
    }
  }
}

findAndPatch(collection.item);

// 3. Guardar el archivo modificado
fs.writeFileSync(DEV_FILE, JSON.stringify(collection, null, 4), 'utf8');

console.log('\n===============================================================');
console.log('       REPORTE DE INYECCIÓN QUIRÚRGICA EN POSTMAN DEV2         ');
console.log('===============================================================');
console.log(`Archivo objetivo: ${DEV_FILE}`);
console.log(`_postman_id: ${collection.info._postman_id}`);
console.log(`Endpoints totales analizados: ${totalRequests}`);
console.log(`Endpoints modificados quirúrgicamente: ${modifiedCount}`);
console.log(`Endpoints intactos (sin alteración): ${totalRequests - modifiedCount}`);
console.log('---------------------------------------------------------------');
report.forEach((r, idx) => {
  console.log(`${idx + 1}. [${r.status}] ${r.endpoint}`);
  console.log(`   Ruta: ${r.path}`);
  console.log(`   Acción: ${r.detalles}`);
});
console.log('===============================================================\n');
console.log('✅ Archivo listo para importar y reemplazar en la app de Postman.');
console.log('👉 Siguiente paso en Postman:');
console.log('   1. Importar API Contabilium_dev2.postman_collection');
console.log('   2. Reemplazar ÚNICAMENTE dev2');
console.log('   3. Abrir dev2 > Merge changes > Ver diff visual side-by-side.');
