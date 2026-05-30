const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciales desde variables de entorno
const INTRANET_URL = 'https://www.tuintranet.cl/razor/';
const INTRANET_USER = process.env.INTRANET_USER || '167448429';
const INTRANET_PASS = process.env.INTRANET_PASS || '16744';

app.use(cors());
app.use(express.json());

// Multer: guardar fotos temporalmente
const upload = multer({ dest: '/tmp/uploads/' });

// ===================== HEALTH CHECK =====================
app.get('/', (req, res) => {
  res.json({ ok: true, mensaje: 'Servidor Medidor funcionando ✅', version: '1.0.0' });
});

// ===================== BUSCAR CUENTA =====================
app.post('/buscar-cuenta', async (req, res) => {
  const { cuenta } = req.body;
  if (!cuenta) return res.json({ ok: false, mensaje: 'Cuenta requerida' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await login(page);

    // Navegar a cambio de medidor
    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', { waitUntil: 'networkidle0' });

    // Seleccionar móvil (primer option disponible)
    await page.waitForSelector('select', { timeout: 5000 }).catch(() => {});

    // Ingresar cuenta
    await page.waitForSelector('input[placeholder*="cuenta"], #txt_search, input[type="text"]', { timeout: 5000 }).catch(() => {});

    // Buscar el campo de cuenta
    const inputCuenta = await page.$('input[id*="search"], input[placeholder*="cuenta"]');
    if (inputCuenta) {
      await inputCuenta.click({ clickCount: 3 });
      await inputCuenta.type(cuenta);
    }

    // Click en Iniciar formulario
    const btnIniciar = await page.$('input[value*="Iniciar"], button[id*="iniciar"], input[id*="iniciar"]');
    if (btnIniciar) {
      await btnIniciar.click();
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
    }

    // Extraer datos del cliente
    const datos = await page.evaluate(() => {
      const getText = (label) => {
        const rows = document.querySelectorAll('.info-row, tr, div');
        for (const row of rows) {
          if (row.textContent.includes(label)) {
            const next = row.nextElementSibling;
            if (next) return next.textContent.trim();
          }
        }
        // Buscar en innerText del contenido principal
        const content = document.getElementById('contentPrincipal_div_result');
        if (!content) return '—';
        const text = content.innerText;
        const idx = text.indexOf(label);
        if (idx === -1) return '—';
        const after = text.substring(idx + label.length).trim();
        return after.split('\n')[0].trim();
      };

      return {
        cuenta: getText('Cuenta'),
        cliente: getText('Cliente'),
        direccion: getText('Dirección'),
        comuna: getText('Comuna'),
        lectura_ant: getText('Lectura'),
        motivo: getText('Motivo'),
        nRetirado: getText('N° retirado'),
        marcaRetirada: getText('Marca retirado'),
      };
    });

    await browser.close();
    res.json({ ok: true, ...datos });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error buscar-cuenta:', e.message);
    res.json({ ok: false, mensaje: e.message });
  }
});

// ===================== ENVIAR FORMULARIO =====================
app.post('/enviar-formulario', upload.fields([
  { name: 'foto1', maxCount: 1 },
  { name: 'foto2', maxCount: 1 },
  { name: 'foto3', maxCount: 1 },
  { name: 'foto5', maxCount: 1 },
]), async (req, res) => {
  const { cuenta, lectura, barcode } = req.body;
  const fotos = req.files;

  if (!cuenta || !lectura || !barcode) {
    return res.json({ ok: false, mensaje: 'Faltan datos: cuenta, lectura o barcode' });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await login(page);

    // Ir a cambio de medidor
    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', {
      waitUntil: 'networkidle0', timeout: 30000
    });

    // Esperar y llenar el campo de cuenta
    await page.waitForSelector('#txt_search', { timeout: 10000 });
    await page.click('#txt_search', { clickCount: 3 });
    await page.type('#txt_search', cuenta);

    // Click en Iniciar formulario
    await page.waitForSelector('input[value*="Iniciar"], button:contains("Iniciar")', { timeout: 5000 }).catch(() => {});
    
    // Buscar botón de iniciar formulario
    await page.evaluate(() => {
      const btns = document.querySelectorAll('input[type="submit"], button');
      for (const btn of btns) {
        if (btn.value?.includes('Iniciar') || btn.textContent?.includes('Iniciar')) {
          btn.click();
          return;
        }
      }
    });

    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});

    // Ingresar LECTURA
    await page.waitForSelector('#contentPrincipal_txt_read', { timeout: 10000 });
    
    // Marcar checkbox de lectura si existe
    const chk = await page.$('#contentPrincipal_chk_lectura');
    if (chk) {
      const isChecked = await page.$eval('#contentPrincipal_chk_lectura', el => el.checked);
      if (!isChecked) await chk.click();
    }

    await page.click('#contentPrincipal_txt_read', { clickCount: 3 });
    await page.type('#contentPrincipal_txt_read', lectura.toString());

    // Seleccionar CÓDIGO DE BARRA en el dropdown
    await page.waitForSelector('#ddl_code_bar', { timeout: 5000 });
    await page.select('#ddl_code_bar', barcode);

    // Click en botón FOTOS
    await page.waitForSelector('#contentPrincipal_btn_photos', { timeout: 5000 });
    await page.click('#contentPrincipal_btn_photos');
    
    // Esperar modal de fotos
    await page.waitForSelector('#contentPrincipal_fup_file_1', { timeout: 10000 });
    await sleep(1000);

    // Subir las 4 fotos
    const fotoMap = {
      '#contentPrincipal_fup_file_1': fotos.foto1?.[0]?.path,
      '#contentPrincipal_fup_file_2': fotos.foto2?.[0]?.path,
      '#contentPrincipal_fup_file_3': fotos.foto3?.[0]?.path,
      '#contentPrincipal_fup_file_5': fotos.foto5?.[0]?.path,
    };

    for (const [selector, filePath] of Object.entries(fotoMap)) {
      if (filePath) {
        const input = await page.$(selector);
        if (input) {
          await input.uploadFile(filePath);
          await sleep(500);
        }
      }
    }

    // Click en SUBIR FOTOS
    await page.waitForSelector('#contentPrincipal_btn_modal_all_insert', { timeout: 5000 });
    await page.click('#contentPrincipal_btn_modal_all_insert');
    await sleep(3000);

    // Click en FINALIZAR
    await page.waitForSelector('#contentPrincipal_btn_finish', { timeout: 10000 });
    await page.click('#contentPrincipal_btn_finish');
    await sleep(2000);

    // Obtener ID del formulario si aparece
    const idForm = await page.evaluate(() => {
      const content = document.body.innerText;
      const match = content.match(/ID Form[:\s]+(\d+)/);
      return match ? match[1] : null;
    });

    await browser.close();

    // Limpiar archivos temporales
    Object.values(fotoMap).forEach(p => { if (p) fs.unlink(p, () => {}); });

    res.json({ ok: true, mensaje: 'Formulario enviado exitosamente', idForm, cuenta, lectura, barcode });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error enviar-formulario:', e.message);
    res.json({ ok: false, mensaje: e.message });
  }
});

// ===================== HELPERS =====================
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

async function login(page) {
  await page.goto(INTRANET_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  
  // Buscar campos de login
  const userField = await page.$('input[type="text"], input[name*="user"], input[id*="user"], input[name*="login"]');
  const passField = await page.$('input[type="password"]');

  if (userField && passField) {
    await userField.click({ clickCount: 3 });
    await userField.type(INTRANET_USER);
    await passField.click({ clickCount: 3 });
    await passField.type(INTRANET_PASS);
    
    // Submit
    const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passField.press('Enter');
    }
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===================== INICIO =====================
app.listen(PORT, () => {
  console.log(`🚀 Servidor medidor corriendo en puerto ${PORT}`);
});
