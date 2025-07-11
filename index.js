globalThis.crypto = require('crypto');

const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const qrcode = require('qrcode-terminal');

// 🔁 CAMBIO APLICADO AQUÍ:
const base64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
const decoded = Buffer.from(base64, 'base64').toString('utf8');
const credentials = JSON.parse(decoded); // 
const GROUPS = ['WHATSAPP 1🎯', 'WHATSAPP 2 🎯'];
const SHEET_ID = '12DHE-5ybnIZqCnH_Em6uOiydSTkfz6bYHsANSu3GhCE';
const ADMIN_PHONE = '+573172440053';
const ALERT_PHONE = '61423758090';

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state, syncFullHistory: false, getMessage: async () => ({}) });

  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Conexión cerrada:', connection, '— Reconectar:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
    } else if (connection === 'open') {
      console.log('✅ Bot conectado correctamente');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.key.remoteJid.endsWith('@g.us')) continue;
      if (msg.key.fromMe || msg.message?.protocolMessage) continue;

      const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!rawText) return;

      const { subject: groupName } = await sock.groupMetadata(msg.key.remoteJid);
      if (!GROUPS.includes(groupName)) return;

      for (const line of rawText.trim().split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+([A-Za-z0-9]+)\s*(\S*)/);
        if (!match) continue;

        const cantidad = Math.min(parseInt(match[1]), 8);
        const platformRaw = match[2].toUpperCase();
        const durationRaw = match[3] ? match[3].toUpperCase() : '';

        try {
          const { success, lista, faltaron } = await getCuentasDisponibles(platformRaw, durationRaw, cantidad);

          if (!success) {
            await sock.sendMessage(`${ADMIN_PHONE}@s.whatsapp.net`, { text: `⚠️ Plataforma no válida: *${platformRaw}* en grupo *${groupName}*` });
            continue;
          }

          if (lista.length > 0) {
            for (const cuenta of lista) {
              const mensaje = `📦 *Cuenta Entregada*\n\n📧 *Correo:* ${cuenta.correo}\n🔑 *Contraseña:* ${cuenta.password}\n📝 *Descripción:* ${cuenta.descripcion}`;
              await sock.sendMessage(msg.key.remoteJid, { text: mensaje });
            }
            if (faltaron) {
              await sock.sendMessage(msg.key.remoteJid, { text: `⚠️ Solo se encontraron *${lista.length} cuentas* de *${platformRaw}*.` + '\nPor favor intenta más tarde para completar tu pedido.' });
            }
            const restantes = await cuentasRestantes(platformRaw);
            if (restantes === 2) {
              await sendAlert(`⚠️ Solo quedan *2 cuentas* disponibles de *${platformRaw}*.`);
            }
          } else {
            const avisoGrupo = `⚠️ Estamos en Creación de Cuentas de *${platformRaw}* en este momento.` + '\nPor favor intenta en 10 minutos nuevamente.';
            await sock.sendMessage(msg.key.remoteJid, { text: avisoGrupo });

            console.log('[DEBUG] Enviando alerta personal a:', ALERT_PHONE);
            await sock.sendMessage(`${ALERT_PHONE}@s.whatsapp.net`, {
              text: `🚨 *Alerta de cuentas*\nSe solicitó *${platformRaw}${durationRaw ? ' ' + durationRaw : ''}* en “${groupName}” y no había cuentas disponibles.`
            });
          }
        } catch (err) {
          console.error('❌ Error al procesar mensaje:', err);
          await sendAlert(`❌ Error al entregar cuenta en *${groupName}*: ${err.message}`);
        }
      }
    }
  });
}

async function getCuentasDisponibles(plataformaRaw, duracionRaw, cantidad) {
  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth(credentials); // ✅ usando las credenciales decodificadas
  await doc.loadInfo();

  const platform = plataformaRaw;
  let duration;
  if (/^30D?$/.test(duracionRaw)) duration = '30D';
  else if (/^(3M|90D)$/.test(duracionRaw)) duration = '3M';
  else duration = '30D';

  let sheetTitles = [];
  if (platform === 'YOUTUBE') {
    sheetTitles = [`YOUTUBE ${duration}`];
  } else if (platform === 'SPOTIFY') {
    sheetTitles = [`SPOTIFY ${duration}`];
  } else {
    const allTitles = Object.keys(doc.sheetsByTitle);
    const matching = allTitles.filter(t => t.toUpperCase().startsWith(platform));
    if (!matching.length) return { success: false, lista: [], faltaron: false };
    const exact = matching.filter(t => t.toUpperCase().includes(duration));
    sheetTitles = exact.length ? exact : matching;
  }

  for (const title of sheetTitles) {
    const sheet = doc.sheetsByTitle[title];
    if (!sheet) continue;
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();

    const disponibles = rows.filter(r => r['ESTADO'] === false || r['ESTADO'] === 'FALSE');
    const entregadas = disponibles.slice(0, cantidad);
    if (!entregadas.length) continue;

    const lista = [];
    for (const cuenta of entregadas) {
      const idx = sheet.headerValues.indexOf('ESTADO');
      cuenta._rawData[idx] = true;
      await new Promise(r => setTimeout(r, 200));
      await cuenta.save();
      lista.push({ correo: cuenta['CORREO'], password: cuenta['CONTRASEÑAS'], descripcion: cuenta['DESCRIPCION'] });
    }
    return { success: true, lista, faltaron: entregadas.length < cantidad };
  }
  return { success: true, lista: [], faltaron: true };
}

async function cuentasRestantes(plataformaRaw) {
  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth(credentials);
  await doc.loadInfo();
  const matching = Object.keys(doc.sheetsByTitle).filter(t => t.toUpperCase().startsWith(plataformaRaw));
  let total = 0;
  for (const title of matching) {
    const sheet = doc.sheetsByTitle[title];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    total += rows.filter(r => r['ESTADO'] === false || r['ESTADO'] === 'FALSE').length;
  }
  return total;
}

async function sendAlert(text) {
  const { state } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });
  await sock.sendMessage(`${ADMIN_PHONE}@s.whatsapp.net`, { text });
}

connectToWhatsApp().catch(console.error);
