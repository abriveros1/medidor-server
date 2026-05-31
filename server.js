const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const INTRANET_URL = 'https://www.tuintranet.cl/razor/';
const INTRANET_USER = process.env.INTRANET_USER || '167448429';
const INTRANET_PASS = process.env.INTRANET_PASS || '16744';

app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

app.get('/', (req, res) => {
  res.json({ ok: true, mensaje: 'Servidor Medidor funcionando ✅' });
});

// ===================== BUSCAR CUENTA =====================
app.post('/buscar-cuenta', async (req, res) => {
  const { cuenta } = req.body;
  if (!cuenta) return res.json({ ok: false, mensaje: 'Cuenta requerida' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await login(page);
    console.log('Login OK, navegando a map_change...');

    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await sleep(2000);

    // Ingresar cuenta en el campo de búsqueda
    await page.waitForSelector('#txt_search', { timeout: 15000 });
    await page.click('#txt_search', { clickCount: 3 });
    await page.type('#txt_search', cuenta.toString());
    console.log('Cuenta ingresada:', cuenta);

    // Primero revisar si la cuenta ya está en lista de pendientes
    const pendienteClick = await page.evaluate((cuentaBuscar) => {
      const items = [...document.querySelectorAll('a, div, span, li, td')];
      const pendiente = items.find(el => 
        el.textContent.trim().startsWith(cuentaBuscar) && 
        !el.children.length || (el.textContent.includes(cuentaBuscar) && el.className.includes('list'))
      );
      if (pendiente) { pendiente.click(); return true; }
      return false;
    }, cuenta.toString());

    if (pendienteClick) {
      console.log('Cuenta encontrada en pendientes, abriendo...');
      await sleep(4000);
    } else {
      // Iniciar formulario nuevo
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('input[type="submit"], button, input[type="button"]')];
        const btn = btns.find(b => (b.value || b.textContent || '').toLowerCase().includes('iniciar'));
        if (btn) btn.click();
      });
      await sleep(4000);

      // Si no encontró, buscar en lista de pendientes por texto
      const enPendientes = await page.evaluate((cuentaBuscar) => {
        const links = [...document.querySelectorAll('a, [onclick]')];
        const link = links.find(el => el.textContent.includes(cuentaBuscar));
        if (link) { link.click(); return true; }
        return false;
      }, cuenta.toString());

      if (enPendientes) {
        console.log('Abriendo desde lista pendientes...');
        await sleep(4000);
      }
    }

    // Extraer datos del formulario abierto
    const datos = await page.evaluate(() => {
      const content = document.getElementById('contentPrincipal_div_result');
      if (!content) return null;
      const text = content.innerText;

      const getVal = (label) => {
        const idx = text.indexOf(label);
        if (idx === -1) return '—';
        return text.substring(idx + label.length).trim().split('\n')[0].trim();
      };

      return {
        cuenta: getVal('Cuenta'),
        cliente: getVal('Cliente'),
        direccion: getVal('Dirección'),
        comuna: getVal('Comuna'),
        lectura_ant: getVal('Lectura'),
        motivo: getVal('Motivo'),
        nRetirado: getVal('N° retirado'),
        marcaRetirada: getVal('Marca retirado'),
      };
    });

    await browser.close();

    if (datos && datos.cliente !== '—') {
      res.json({ ok: true, ...datos });
    } else {
      res.json({ ok: false, mensaje: 'Cuenta no encontrada. Verifica el número.' });
    }

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
    return res.json({ ok: false, mensaje: 'Faltan datos' });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    await login(page);

    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await sleep(2000);

    // Ingresar cuenta
    await page.waitForSelector('#txt_search', { timeout: 15000 });
    await page.click('#txt_search', { clickCount: 3 });
    await page.type('#txt_search', cuenta.toString());

    // Intentar abrir desde pendientes primero
    const pendienteClick = await page.evaluate((cuentaBuscar) => {
      const links = [...document.querySelectorAll('a, [onclick], div, span')];
      const link = links.find(el => el.textContent.includes(cuentaBuscar));
      if (link) { link.click(); return true; }
      return false;
    }, cuenta.toString());

    if (!pendienteClick) {
      // Iniciar formulario nuevo
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('input[type="submit"], button, input[type="button"]')];
        const btn = btns.find(b => (b.value || b.textContent || '').toLowerCase().includes('iniciar'));
        if (btn) btn.click();
      });
    }

    await sleep(4000);

    // Marcar checkbox lectura
    const chk = await page.$('#contentPrincipal_chk_lectura');
    if (chk) {
      const checked = await page.$eval('#contentPrincipal_chk_lectura', el => el.checked);
      if (!checked) await chk.click();
    }

    // Ingresar lectura
    await page.waitForSelector('#contentPrincipal_txt_read', { timeout: 10000 });
    await page.click('#contentPrincipal_txt_read', { clickCount: 3 });
    await page.type('#contentPrincipal_txt_read', lectura.toString());
    console.log('Lectura ingresada:', lectura);

    // Seleccionar código de barra
    await page.waitForSelector('#ddl_code_bar', { timeout: 10000 });
    await page.select('#ddl_code_bar', barcode.toString());
    console.log('Código de barra:', barcode);

    await sleep(1000);

    // Click en botón FOTOS
    await page.click('#contentPrincipal_btn_photos');
    await sleep(3000);

    // Subir fotos
    const fotoMap = [
      { selector: '#contentPrincipal_fup_file_1', file: fotos.foto1?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_2', file: fotos.foto2?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_3', file: fotos.foto3?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_5', file: fotos.foto5?.[0]?.path },
    ];

    for (const { selector, file } of fotoMap) {
      if (file) {
        const input = await page.$(selector);
        if (input) {
          await input.uploadFile(file);
          await sleep(500);
          console.log('Foto subida:', selector);
        }
      }
    }

    // Click Subir fotos
    await page.click('#contentPrincipal_btn_modal_all_insert');
    await sleep(4000);

    // Click Finalizar
    await page.waitForSelector('#contentPrincipal_btn_finish', { timeout: 15000 });
    await page.click('#contentPrincipal_btn_finish');
    await sleep(3000);

    console.log('Formulario finalizado OK');
    await browser.close();

    fotoMap.forEach(({ file }) => { if (file) fs.unlink(file, () => {}); });

    res.json({ ok: true, mensaje: 'Formulario enviado exitosamente', cuenta, lectura, barcode });

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
      '--no-zygote',
    ],
  });
}

async function login(page) {
  console.log('Iniciando login...');
  await page.goto(INTRANET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await sleep(2000);

  const userSelectors = ['input[name*="user"]', 'input[id*="user"]', 'input[name*="login"]', 'input[type="text"]'];
  let userField = null;
  for (const sel of userSelectors) {
    userField = await page.$(sel);
    if (userField) break;
  }

  const passField = await page.$('input[type="password"]');

  if (userField && passField) {
    await userField.click({ clickCount: 3 });
    await userField.type(INTRANET_USER);
    await passField.click({ clickCount: 3 });
    await passField.type(INTRANET_PASS);

    const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passField.press('Enter');
    }

    await sleep(4000);
    console.log('Login OK, URL:', page.url());
  } else {
    console.log('Sin campos login, puede que ya esté logueado');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`🚀 Servidor medidor corriendo en puerto ${PORT}`);
});
