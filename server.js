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

// Timeouts más generosos para Railway
const NAV_TIMEOUT  = 120000; // 2 min para navegación
const ELEM_TIMEOUT = 30000;  // 30s para esperar elementos

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

app.get('/', (req, res) => {
  res.json({ ok: true, mensaje: 'Servidor Medidor funcionando ✅' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'online', version: '2.0.0' });
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
    return res.json({ ok: false, mensaje: 'Faltan datos: cuenta=' + cuenta + ' lectura=' + lectura + ' barcode=' + barcode });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(ELEM_TIMEOUT);

    // ---- LOGIN ----
    await login(page);

    // ---- NAVEGAR A map_change ----
    console.log('Navegando a map_change...');
    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', {
      waitUntil: 'networkidle2',
      timeout: NAV_TIMEOUT
    });
    console.log('map_change cargado, URL:', page.url());
    await sleep(3000);

    // ---- BUSCAR CUENTA ----
    console.log('Buscando cuenta:', cuenta);
    await page.waitForSelector('#txt_search', { timeout: ELEM_TIMEOUT });
    await page.click('#txt_search', { clickCount: 3 });
    await page.type('#txt_search', cuenta.toString());
    await sleep(1000);

    // Buscar en lista de pendientes por texto de la cuenta
    const pendienteClick = await page.evaluate((cuentaBuscar) => {
      const links = [...document.querySelectorAll('a, [onclick]')];
      const link = links.find(el => el.textContent.trim().includes(cuentaBuscar));
      if (link) { link.click(); return true; }
      return false;
    }, cuenta.toString());

    if (!pendienteClick) {
      console.log('No está en pendientes, buscando botón Iniciar...');
      const clickedIniciar = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('input[type="submit"], button, input[type="button"]')];
        const btn = btns.find(b => (b.value || b.textContent || '').toLowerCase().includes('iniciar'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      console.log('Botón Iniciar clickeado:', clickedIniciar);
    } else {
      console.log('Cuenta abierta desde pendientes');
    }

    // Esperar que cargue el formulario
    await sleep(5000);

    // ---- LECTURA ----
    // Marcar checkbox de lectura si existe
    try {
      const chk = await page.$('#contentPrincipal_chk_lectura');
      if (chk) {
        const checked = await page.$eval('#contentPrincipal_chk_lectura', el => el.checked);
        if (!checked) await chk.click();
        await sleep(500);
        console.log('Checkbox lectura marcado');
      }
    } catch(e) { console.log('Sin checkbox lectura:', e.message); }

    await page.waitForSelector('#contentPrincipal_txt_read', { timeout: ELEM_TIMEOUT });
    await page.click('#contentPrincipal_txt_read', { clickCount: 3 });
    await page.type('#contentPrincipal_txt_read', lectura.toString());
    console.log('Lectura ingresada:', lectura);

    // ---- CÓDIGO DE BARRAS ----
    await page.waitForSelector('#ddl_code_bar', { timeout: ELEM_TIMEOUT });

    // Obtener opciones disponibles para debug
    const opciones = await page.$$eval('#ddl_code_bar option', opts =>
      opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
    );
    console.log('Opciones ddl_code_bar:', JSON.stringify(opciones));

    // Intentar selección exacta primero, luego buscar coincidencia parcial
    const barcodeStr = barcode.toString();
    const opcionExacta = opciones.find(o => o.value === barcodeStr || o.text.includes(barcodeStr));
    if (opcionExacta) {
      await page.select('#ddl_code_bar', opcionExacta.value);
      console.log('Código de barra seleccionado:', opcionExacta.value, '-', opcionExacta.text);
    } else {
      // Fallback: buscar opción que contenga los primeros 7 dígitos
      const prefix7 = barcodeStr.slice(0, 7);
      const opcionParcial = opciones.find(o => o.value.includes(prefix7) || o.text.includes(prefix7));
      if (opcionParcial) {
        await page.select('#ddl_code_bar', opcionParcial.value);
        console.log('Código de barra (parcial) seleccionado:', opcionParcial.value);
      } else {
        console.warn('⚠️ Código de barra no encontrado en opciones. Barcode:', barcodeStr, 'Opciones:', opciones);
        // Continuar de todas formas
      }
    }

    await sleep(1500);

    // ---- FOTOS ----
    // Click en botón FOTOS
    try {
      await page.waitForSelector('#contentPrincipal_btn_photos', { timeout: 10000 });
      await page.click('#contentPrincipal_btn_photos');
      await sleep(3000);
      console.log('Modal fotos abierto');
    } catch(e) {
      console.log('Sin botón fotos o ya visible:', e.message);
    }

    const fotoMap = [
      { selector: '#contentPrincipal_fup_file_1', file: fotos.foto1?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_2', file: fotos.foto2?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_3', file: fotos.foto3?.[0]?.path },
      { selector: '#contentPrincipal_fup_file_5', file: fotos.foto5?.[0]?.path },
    ];

    for (const { selector, file } of fotoMap) {
      if (file) {
        try {
          const input = await page.$(selector);
          if (input) {
            await input.uploadFile(file);
            await sleep(800);
            console.log('Foto subida:', selector);
          } else {
            console.log('Input no encontrado:', selector);
          }
        } catch(e) { console.log('Error subiendo foto', selector, ':', e.message); }
      }
    }

    // Click Insertar fotos
    try {
      await page.waitForSelector('#contentPrincipal_btn_modal_all_insert', { timeout: 10000 });
      await page.click('#contentPrincipal_btn_modal_all_insert');
      await sleep(4000);
      console.log('Fotos insertadas');
    } catch(e) { console.log('Sin botón insertar fotos:', e.message); }

    // ---- FINALIZAR ----
    await page.waitForSelector('#contentPrincipal_btn_finish', { timeout: ELEM_TIMEOUT });
    await page.click('#contentPrincipal_btn_finish');
    await sleep(4000);
    console.log('✅ Formulario finalizado OK — cuenta:', cuenta);

    await browser.close();
    fotoMap.forEach(({ file }) => { if (file) fs.unlink(file, () => {}); });

    res.json({ ok: true, mensaje: 'Formulario enviado exitosamente', cuenta, lectura, barcode });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error enviar-formulario:', e.message);
    // Limpiar archivos temporales
    if (req.files) {
      Object.values(req.files).flat().forEach(f => fs.unlink(f.path, () => {}));
    }
    res.json({ ok: false, mensaje: e.message });
  }
});

// ===================== BUSCAR CUENTA =====================
app.post('/buscar-cuenta', async (req, res) => {
  const { cuenta } = req.body;
  if (!cuenta) return res.json({ ok: false, mensaje: 'Cuenta requerida' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    page.setDefaultTimeout(ELEM_TIMEOUT);

    await login(page);

    await page.goto('https://www.tuintranet.cl/razor/dynamic_menu/map_change.aspx', {
      waitUntil: 'networkidle2',
      timeout: NAV_TIMEOUT
    });
    await sleep(3000);

    await page.waitForSelector('#txt_search', { timeout: ELEM_TIMEOUT });
    await page.click('#txt_search', { clickCount: 3 });
    await page.type('#txt_search', cuenta.toString());
    await sleep(1000);

    const pendienteClick = await page.evaluate((cuentaBuscar) => {
      const links = [...document.querySelectorAll('a, [onclick]')];
      const link = links.find(el => el.textContent.includes(cuentaBuscar));
      if (link) { link.click(); return true; }
      return false;
    }, cuenta.toString());

    if (!pendienteClick) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('input[type="submit"], button, input[type="button"]')];
        const btn = btns.find(b => (b.value || b.textContent || '').toLowerCase().includes('iniciar'));
        if (btn) btn.click();
      });
    }

    await sleep(5000);

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
      res.json({ ok: false, mensaje: 'Cuenta no encontrada' });
    }

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error buscar-cuenta:', e.message);
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
      '--disable-extensions',
      '--disable-background-networking',
    ],
  });
}

async function login(page) {
  console.log('Iniciando login...');
  await page.goto(INTRANET_URL, {
    waitUntil: 'networkidle2',  // esperar que la red se estabilice, no solo DOM
    timeout: NAV_TIMEOUT
  });

  console.log('Login URL:', page.url());
  await sleep(3000);

  // Intentar varios selectores de usuario
  const userSelectors = [
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="login" i]',
    'input[name*="rut" i]',
    'input[type="text"]:not([type="hidden"])',
  ];
  let userField = null;
  for (const sel of userSelectors) {
    userField = await page.$(sel);
    if (userField) { console.log('Campo usuario encontrado:', sel); break; }
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

    // Esperar navegación post-login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => {});
    await sleep(3000);
    console.log('Login completado, URL:', page.url());
  } else {
    console.log('Sin campos login — puede que ya esté logueado o la página no cargó bien');
    console.log('URL actual:', page.url());
    // Capturar HTML para debug
    const html = await page.content();
    console.log('HTML primeros 500 chars:', html.slice(0, 500));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`🚀 Servidor medidor v2 corriendo en puerto ${PORT}`);
});
