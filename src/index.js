/**
 * matriz-fe — Cloudflare Worker
 *
 * Rutas de Factura Electrónica para Matriz Contable CR.
 * Migradas desde Vercel serverless functions.
 *
 * Secrets que hay que agregar en Cloudflare Dashboard
 * (Workers → matriz-fe → Settings → Variables → Secrets):
 *   FIRMA_SERVICE_SECRET  — mismo que en matriz-certificados
 *   FIREBASE_API_KEY      — de tu proyecto Firebase
 *   RESEND_API_KEY        — de tu cuenta Resend
 *   RESEND_FROM           — ej: "Matriz Contable CR <facturas@tudominio.com>"
 */

import {
  DocumentType,
  Situation,
  buildClave,
  buildFacturaXml,
  buildTiqueteXml,
  buildNotaCreditoXml,
  buildNotaDebitoXml,
  buildMensajeReceptorXml,
  buildReciboPagoXml,
  calculateLineItemTotals,
  calculateInvoiceSummary,
  signAndEncode,
} from '@dojocoding/hacienda-sdk'

// ─── Constantes ──────────────────────────────────────────────────
const SUCURSAL = '001'
const TERMINAL = '00001'
const RESEND_API_URL = 'https://api.resend.com/emails'
const CODIGO_CONSECUTIVO_POR_MENSAJE = { '1': '05', '2': '06', '3': '07' }

// ─── CORS ────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

// ─── Utilidades compartidas ──────────────────────────────────────
function soloDigitos(valor) {
  return String(valor || '').replace(/[^0-9]/g, '')
}
function limpio(valor) {
  return String(valor || '').trim()
}
function tipoIdentificacionEmisor(cedulaLimpia) {
  if (cedulaLimpia.length === 9) return '01'
  if (cedulaLimpia.length === 10) return '02'
  if (cedulaLimpia.length === 11 || cedulaLimpia.length === 12) return '03'
  return '04'
}
function codigoTarifaPorPorcentaje(tarifa) {
  if (tarifa === 13) return '08'
  if (tarifa === 4) return '04'
  if (tarifa === 2) return '03'
  if (tarifa === 1) return '02'
  if (tarifa === 0.5) return '09'
  return '08'
}
function normalizarLinea(linea, indice) {
  const impuestos = Array.isArray(linea.impuesto) ? linea.impuesto : []
  const tarifa = impuestos.length ? Number(impuestos[0].tarifa) || 0 : 0
  return {
    ...linea,
    numeroLinea: indice + 1,
    impuesto: [{ codigo: '01', codigoTarifaIVA: tarifa > 0 ? codigoTarifaPorPorcentaje(tarifa) : '01', tarifa }],
  }
}
function cedulaDeClave(clave) {
  const d = String(clave || '').replace(/[^0-9]/g, '')
  return d.length === 50 ? d.substr(9, 12) : ''
}
async function leerJsonSeguro(respuesta) {
  const texto = await respuesta.text()
  try {
    return JSON.parse(texto)
  } catch {
    return { error: 'Respuesta no válida (' + respuesta.status + '): ' + texto.slice(0, 200) }
  }
}
function limpiarMensajeHacienda(texto) {
  if (!texto) return texto
  return String(texto)
    .replace(/&#13;/g, '\n').replace(/&#10;/g, '\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
}
function escaparHtml(texto) {
  return String(texto || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── Helpers de Hacienda ─────────────────────────────────────────
async function obtenerAccessToken(entorno, usuario, password) {
  const realm = entorno === 'production' ? 'rut' : 'rut-stag'
  const clientId = entorno === 'production' ? 'api-prod' : 'api-stag'
  const cuerpo = new URLSearchParams({ grant_type: 'password', client_id: clientId, username: usuario, password })
  const respuesta = await fetch(
    'https://idp.comprobanteselectronicos.go.cr/auth/realms/' + realm + '/protocol/openid-connect/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: cuerpo.toString() }
  )
  if (!respuesta.ok) {
    const texto = await respuesta.text().catch(() => '')
    throw new Error('No se pudo autenticar con Hacienda (status ' + respuesta.status + '): ' + (texto || respuesta.statusText))
  }
  return (await respuesta.json()).access_token
}

async function enviarYEsperarDirecto({ baseUrl, entorno, usuario, password, clave, tipoIdEmisor, cedulaEmisor, comprobanteXml }) {
  const token = await obtenerAccessToken(entorno, usuario, password)
  const envioRes = await fetch(baseUrl + '/recepcion', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clave, fecha: new Date().toISOString(), emisor: { tipoIdentificacion: tipoIdEmisor, numeroIdentificacion: cedulaEmisor }, comprobanteXml }),
  })
  if (envioRes.status !== 201 && envioRes.status !== 202) {
    const texto = await envioRes.text().catch(() => '')
    throw new Error('Hacienda rechazó el envío (status ' + envioRes.status + '): ' + texto)
  }
  const limite = Date.now() + 55000
  while (Date.now() < limite) {
    await new Promise(r => setTimeout(r, 3000))
    const tokenVigente = await obtenerAccessToken(entorno, usuario, password)
    const consultaRes = await fetch(baseUrl + '/recepcion/' + clave, { headers: { Authorization: 'Bearer ' + tokenVigente } })
    if (!consultaRes.ok) continue
    const estado = await consultaRes.json()
    const indEstado = estado['ind-estado']
    if (indEstado === 'aceptado') return { accepted: true }
    if (indEstado === 'rechazado') {
      let motivo = 'Rechazado por Hacienda'
      try {
        const xmlRespuesta = Buffer.from(estado['respuesta-xml'], 'base64').toString('utf-8')
        const m = xmlRespuesta.match(/<DetalleMensaje>([^<]*)<\/DetalleMensaje>/i)
        if (m) motivo = limpiarMensajeHacienda(m[1])
      } catch { /* se deja el motivo genérico */ }
      return { accepted: false, rejectionReason: motivo }
    }
  }
  return { accepted: null, pending: true }
}

// ─── Helpers del Worker de certificados ──────────────────────────
async function verificarIdToken(idToken, FIREBASE_API_KEY) {
  if (!idToken || !FIREBASE_API_KEY) return null
  try {
    const respuesta = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    )
    if (!respuesta.ok) return null
    const datos = await respuesta.json()
    const usuario = datos.users && datos.users[0]
    return usuario ? usuario.localId : null
  } catch { return null }
}

async function verificarLimiteRemoto(claveRate, limite, ventanaSegundos, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET) {
  try {
    const respuesta = await fetch(CERTIFICADOS_WORKER_URL + '/verificar-limite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secreto: FIRMA_SERVICE_SECRET, clave: claveRate, limite, ventanaSegundos }),
    })
    if (!respuesta.ok) return true
    return (await respuesta.json()).permitido !== false
  } catch { return true }
}

async function obtenerCertificado(uid, cedulaEmisor, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET) {
  const respCert = await fetch(CERTIFICADOS_WORKER_URL + '/obtener-certificado-firma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, secreto: FIRMA_SERVICE_SECRET, cedulaEmisor: cedulaEmisor || undefined }),
  })
  const datosCert = await leerJsonSeguro(respCert)
  return { ok: respCert.ok, datosCert }
}

async function obtenerSiguienteSecuencia(uid, tipoDocumento, cedulaEmisor, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET) {
  const respuesta = await fetch(CERTIFICADOS_WORKER_URL + '/siguiente-secuencia', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, secreto: FIRMA_SERVICE_SECRET, tipoDocumento, cedulaEmisor: cedulaEmisor || undefined }),
  })
  const datos = await leerJsonSeguro(respuesta)
  if (!respuesta.ok || !datos.secuencia) throw new Error('No se pudo generar el número de secuencia: ' + (datos.error || 'error desconocido'))
  return datos.secuencia
}

async function guardarHistorial(uid, registro, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET) {
  try {
    await fetch(CERTIFICADOS_WORKER_URL + '/guardar-historial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, secreto: FIRMA_SERVICE_SECRET, registro }),
    })
  } catch (err) {
    console.error('No se pudo guardar el historial:', err.message)
  }
}

function calcularResumen(lineas) {
  const lineasNormalizadas = lineas.map(normalizarLinea)
  const lineasCalculadas = lineasNormalizadas.map(calculateLineItemTotals)
  const resumen = calculateInvoiceSummary(lineasCalculadas)
  const sinIva = lineasNormalizadas.every(l => l.impuesto[0].tarifa === 0)
  if (sinIva) {
    const totalLineas = lineasCalculadas.reduce((suma, l) => suma + l.montoTotalLinea, 0)
    Object.assign(resumen, {
      totalServGravados: 0, totalServExentos: 0, totalServExonerado: 0, totalServNoSujeto: totalLineas,
      totalGravado: 0, totalExento: 0, totalExonerado: 0, totalNoSujeto: totalLineas,
      totalVenta: totalLineas, totalVentaNeta: totalLineas,
      totalDesgloseImpuesto: [{ codigo: '01', codigoTarifaIVA: '01', totalMontoImpuesto: 0 }],
      totalImpuesto: 0, totalComprobante: totalLineas,
    })
  }
  return { lineasCalculadas, resumen }
}

function armarEmisor(datosCert, emisorNombre) {
  const { cedulaEmisor, provincia, canton, distrito, otrasSenas } = datosCert
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  return {
    nombre: emisorNombre || cedulaLimpia,
    identificacion: { tipo: tipoIdentificacionEmisor(cedulaLimpia), numero: cedulaLimpia },
    ubicacion: {
      provincia: limpio(provincia) || '1', canton: limpio(canton) || '01',
      distrito: limpio(distrito) || '01', otrasSenas: limpio(otrasSenas) || 'N/A',
    },
  }
}

// ─── Rutas ───────────────────────────────────────────────────────

// POST /firmar-factura
async function handleFirmarFactura(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const {
    idToken, receptor, lineas, condicionVenta, plazoCredito, medioPago,
    esTiquete, emisorNombre, cedulaEmisor: cedulaEmisorElegida,
  } = body || {}

  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('firmar:' + uid, 20, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Alcanzaste el límite de facturas por hora. Esperá un rato.' }, 429)
  if (!Array.isArray(lineas) || !lineas.length) return jsonResponse({ error: 'Faltan datos: lineas es obligatorio.' }, 400)
  if (!esTiquete && !receptor) return jsonResponse({ error: 'Para una Factura Electrónica hace falta el receptor.' }, 400)

  const plazoCreditoLimpio = String(plazoCredito || '').replace(/[^0-9]/g, '')
  const esCreditoVenta = condicionVenta === '02' || condicionVenta === '10'
  if (esCreditoVenta && !plazoCreditoLimpio) return jsonResponse({ error: 'Para facturar a crédito hace falta el plazo en días.' }, 400)
  if (condicionVenta === '10' && Number(plazoCreditoLimpio) > 90) return jsonResponse({ error: 'El crédito Art. 27 permite máximo 90 días.' }, 400)

  const { ok, datosCert } = await obtenerCertificado(uid, soloDigitos(cedulaEmisorElegida || '') || undefined, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener el certificado: ' + (datosCert.error || 'error desconocido') }, 502)

  const { certificadoBase64, contrasena: p12Pin, cedulaEmisor, usuarioHacienda, passwordHacienda, actividadEconomica, ambiente } = datosCert
  if (!certificadoBase64 || !cedulaEmisor || !usuarioHacienda || !passwordHacienda || !actividadEconomica)
    return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const p12Buffer = Buffer.from(certificadoBase64, 'base64')
  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  const tipoIdEmisor = tipoIdentificacionEmisor(cedulaLimpia)

  const secuencia = await obtenerSiguienteSecuencia(uid, esTiquete ? 'tiquete' : 'factura', cedulaLimpia, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  const { lineasCalculadas, resumen } = calcularResumen(lineas)
  resumen.medioPago = [{ tipoMedioPago: (Array.isArray(medioPago) && medioPago[0]) || '01', totalMedioPago: resumen.totalComprobante }]

  const tipoDocumento = esTiquete ? DocumentType.TIQUETE_ELECTRONICO : DocumentType.FACTURA_ELECTRONICA
  const codigoTipo = esTiquete ? '04' : '01'
  const clave = buildClave({ date: new Date(), taxpayerId: cedulaLimpia, documentType: tipoDocumento, sequence: secuencia, situation: Situation.NORMAL })
  const numeroConsecutivo = SUCURSAL + TERMINAL + codigoTipo + String(secuencia).padStart(10, '0')

  const documento = {
    clave, codigoActividadEmisor: limpio(actividadEconomica), proveedorSistemas: cedulaLimpia,
    numeroConsecutivo, fechaEmision: new Date().toISOString(),
    emisor: armarEmisor(datosCert, emisorNombre),
    condicionVenta: condicionVenta || '01', detalleServicio: lineasCalculadas, resumenFactura: resumen,
  }
  if (esCreditoVenta) documento.plazoCredito = plazoCreditoLimpio
  let xml
  if (esTiquete) {
    xml = buildTiqueteXml(documento)
  } else {
    documento.receptor = receptor
    xml = buildFacturaXml(documento)
  }

  const xmlFirmadoBase64 = await signAndEncode(xml, p12Buffer, p12Pin)
  const baseUrl = entorno === 'production'
    ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1'
    : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'

  const resultado = await enviarYEsperarDirecto({ baseUrl, entorno, usuario: usuarioHacienda, password: passwordHacienda, clave, tipoIdEmisor, cedulaEmisor: cedulaLimpia, comprobanteXml: xmlFirmadoBase64 })

  const estadoHistorial = resultado.accepted === true ? 'aceptado' : resultado.accepted === false ? 'rechazado' : 'pendiente'
  await guardarHistorial(uid, {
    clave, numeroConsecutivo, ambiente: entorno, estado: estadoHistorial,
    motivoRechazo: estadoHistorial === 'rechazado' ? resultado.rejectionReason : null,
    fecha: new Date().toISOString(), esTiquete: !!esTiquete,
    emisorNombre: emisorNombre || cedulaLimpia,
    receptorNombre: receptor ? receptor.nombre : null,
    receptorCedula: receptor && receptor.identificacion ? receptor.identificacion.numero : null,
    receptorEmail: receptor ? receptor.correoElectronico : null,
    total: resumen.totalComprobante, lineas,
    condicionVenta: condicionVenta || '01',
    plazoCredito: esCreditoVenta ? plazoCreditoLimpio : null,
    medioPago: medioPago || ['01'], xmlFirmadoBase64,
  }, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  return jsonResponse({
    ok: true, aceptado: resultado.accepted, pendiente: resultado.pending === true,
    motivoRechazo: resultado.accepted === false ? resultado.rejectionReason : null,
    mensajePendiente: resultado.pending === true ? 'Hacienda no confirmó a tiempo (55s), pero el comprobante SÍ fue recibido. Guardá la clave y consultá más tarde en ATV.' : null,
    clave, numeroConsecutivo, ambiente: entorno, xmlFirmadoBase64,
  })
}

// POST /consultar-estado
async function handleConsultarEstado(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const { idToken, clave } = body || {}
  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('consultar:' + uid, 30, 300, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Demasiadas consultas. Esperá un momento.' }, 429)
  if (!clave) return jsonResponse({ error: 'Falta la clave a consultar.' }, 400)
  const claveLimpia = String(clave).replace(/[^0-9]/g, '')
  if (claveLimpia.length !== 50) return jsonResponse({ error: 'La clave debe tener 50 dígitos.' }, 400)

  const { ok, datosCert } = await obtenerCertificado(uid, cedulaDeClave(claveLimpia) || undefined, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener tus credenciales de Hacienda: ' + (datosCert.error || 'error desconocido') }, 502)

  const { usuarioHacienda, passwordHacienda, ambiente } = datosCert
  if (!usuarioHacienda || !passwordHacienda) return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const baseUrl = entorno === 'production'
    ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1'
    : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'

  const token = await obtenerAccessToken(entorno, usuarioHacienda, passwordHacienda)
  const consultaRes = await fetch(baseUrl + '/recepcion/' + claveLimpia, { headers: { Authorization: 'Bearer ' + token } })

  if (consultaRes.status === 404) {
    return jsonResponse({ ok: true, estado: 'no_encontrado', clave: claveLimpia, ambiente: entorno, mensaje: 'Hacienda no tiene ese comprobante en este ambiente (' + entorno + ').' })
  }
  if (!consultaRes.ok) {
    const texto = await consultaRes.text().catch(() => '')
    throw new Error('Hacienda respondió con status ' + consultaRes.status + ': ' + texto)
  }

  const datosEstado = await consultaRes.json()
  const indEstado = datosEstado['ind-estado']
  let motivoRechazo = null
  if (indEstado === 'rechazado' && datosEstado['respuesta-xml']) {
    try {
      const xmlRespuesta = Buffer.from(datosEstado['respuesta-xml'], 'base64').toString('utf-8')
      const m = xmlRespuesta.match(/<DetalleMensaje>([^<]*)<\/DetalleMensaje>/i)
      if (m) motivoRechazo = limpiarMensajeHacienda(m[1])
    } catch { /* se deja sin motivo */ }
  }
  return jsonResponse({ ok: true, estado: indEstado || 'desconocido', motivoRechazo, clave: claveLimpia, ambiente: entorno })
}

// POST /enviar-correo-factura
async function handleEnviarCorreo(body, env, clientIp) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, RESEND_API_KEY, RESEND_FROM } = env

  if (!RESEND_API_KEY) return jsonResponse({ error: 'Falta configurar RESEND_API_KEY.' }, 500)
  if (!RESEND_FROM) return jsonResponse({ error: 'Falta configurar RESEND_FROM.' }, 500)

  const { receptorEmail, receptorNombre, emisorNombre, emisorEmail, clave, numeroConsecutivo, pdfBase64, xmlBase64, nombreArchivo } = body || {}

  if (!receptorEmail) return jsonResponse({ error: 'Falta el correo del receptor.' }, 400)
  if (!(await verificarLimiteRemoto('correo:' + (clientIp || 'sin-ip'), 15, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Demasiados correos desde esta conexión. Esperá un rato.' }, 429)
  if (!pdfBase64) return jsonResponse({ error: 'Falta el PDF de la factura.' }, 400)

  const nombreBase = nombreArchivo || ('factura-' + (numeroConsecutivo || clave || Date.now()))
  const attachments = [{ filename: nombreBase + '.pdf', content: pdfBase64 }]
  if (xmlBase64) attachments.push({ filename: nombreBase + '.xml', content: xmlBase64 })

  const asunto = 'Factura electrónica de ' + (emisorNombre || 'tu proveedor') + (numeroConsecutivo ? ' — N° ' + numeroConsecutivo : '')
  const html =
    '<p>Hola' + (receptorNombre ? ' ' + escaparHtml(receptorNombre) : '') + ',</p>' +
    '<p>Adjunto encontrás tu factura electrónica' + (emisorNombre ? ' de <b>' + escaparHtml(emisorNombre) + '</b>' : '') + ', ya aceptada por el Ministerio de Hacienda.</p>' +
    (clave ? '<p><b>Clave:</b> ' + escaparHtml(clave) + '</p>' : '') +
    (numeroConsecutivo ? '<p><b>Consecutivo:</b> ' + escaparHtml(numeroConsecutivo) + '</p>' : '') +
    '<p>Se adjunta el comprobante en PDF' + (xmlBase64 ? ' y el XML firmado (requerido para fines tributarios)' : '') + '.</p>' +
    '<p style="color:#888;font-size:12px;">Este correo fue generado automáticamente por Matriz Contable CR.</p>'

  const cuerpo = { from: RESEND_FROM, to: [receptorEmail], subject: asunto, html, attachments }
  if (emisorEmail) cuerpo.reply_to = emisorEmail

  const respuesta = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const texto = await respuesta.text()
  let datos
  try { datos = JSON.parse(texto) } catch { datos = { raw: texto } }
  if (!respuesta.ok) return jsonResponse({ error: 'Resend rechazó el envío (status ' + respuesta.status + '): ' + (datos.message || texto) }, 502)
  return jsonResponse({ ok: true, id: datos.id })
}

// POST /emitir-nota-credito
async function handleNotaCredito(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const { idToken, claveOriginal, fechaOriginal, motivo, receptor, lineas, condicionVenta, medioPago, esTiquete, emisorNombre, cedulaEmisor: cedulaEmisorBody } = body || {}

  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('nota-credito:' + uid, 10, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Alcanzaste el límite de notas de crédito por hora.' }, 429)
  if (!claveOriginal || soloDigitos(claveOriginal).length !== 50) return jsonResponse({ error: 'Falta o es inválida la clave del documento original (50 dígitos).' }, 400)
  if (!Array.isArray(lineas) || !lineas.length) return jsonResponse({ error: 'Faltan datos: lineas es obligatorio.' }, 400)
  if (!esTiquete && !receptor) return jsonResponse({ error: 'Para anular una Factura hace falta el receptor original.' }, 400)

  const cedulaEmisorParaCert = soloDigitos(cedulaEmisorBody || '') || cedulaDeClave(claveOriginal) || undefined
  const { ok, datosCert } = await obtenerCertificado(uid, cedulaEmisorParaCert, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener el certificado: ' + (datosCert.error || 'error desconocido') }, 502)

  const { certificadoBase64, contrasena: p12Pin, cedulaEmisor, usuarioHacienda, passwordHacienda, actividadEconomica, ambiente } = datosCert
  if (!certificadoBase64 || !cedulaEmisor || !usuarioHacienda || !passwordHacienda || !actividadEconomica)
    return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const p12Buffer = Buffer.from(certificadoBase64, 'base64')
  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  const tipoIdEmisor = tipoIdentificacionEmisor(cedulaLimpia)
  const claveOriginalLimpia = soloDigitos(claveOriginal)

  const secuencia = await obtenerSiguienteSecuencia(uid, 'notaCredito', cedulaLimpia, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  const { lineasCalculadas, resumen } = calcularResumen(lineas)
  resumen.medioPago = [{ tipoMedioPago: (Array.isArray(medioPago) && medioPago[0]) || '01', totalMedioPago: resumen.totalComprobante }]

  const clave = buildClave({ date: new Date(), taxpayerId: cedulaLimpia, documentType: DocumentType.NOTA_CREDITO_ELECTRONICA, sequence: secuencia, situation: Situation.NORMAL })
  const numeroConsecutivo = SUCURSAL + TERMINAL + '03' + String(secuencia).padStart(10, '0')

  const documento = {
    clave, codigoActividadEmisor: limpio(actividadEconomica), proveedorSistemas: cedulaLimpia,
    numeroConsecutivo, fechaEmision: new Date().toISOString(),
    emisor: armarEmisor(datosCert, emisorNombre),
    receptor: receptor || { nombre: 'Consumidor final', identificacion: { tipo: '01', numero: cedulaLimpia } },
    condicionVenta: condicionVenta || '01', detalleServicio: lineasCalculadas, resumenFactura: resumen,
    informacionReferencia: [{
      tipoDoc: esTiquete ? '04' : '01', numero: claveOriginalLimpia,
      fechaEmision: fechaOriginal || new Date().toISOString(),
      codigo: '01', razon: limpio(motivo).slice(0, 180) || 'Anulación del comprobante de referencia',
    }],
  }

  const xml = buildNotaCreditoXml(documento)
  const xmlFirmadoBase64 = await signAndEncode(xml, p12Buffer, p12Pin)
  const baseUrl = entorno === 'production' ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1' : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'
  const resultado = await enviarYEsperarDirecto({ baseUrl, entorno, usuario: usuarioHacienda, password: passwordHacienda, clave, tipoIdEmisor, cedulaEmisor: cedulaLimpia, comprobanteXml: xmlFirmadoBase64 })

  const estadoHistorial = resultado.accepted === true ? 'aceptado' : resultado.accepted === false ? 'rechazado' : 'pendiente'
  await guardarHistorial(uid, {
    clave, numeroConsecutivo, ambiente: entorno, estado: estadoHistorial,
    motivoRechazo: estadoHistorial === 'rechazado' ? resultado.rejectionReason : null,
    fecha: new Date().toISOString(), tipoDocumento: 'notaCredito', claveReferenciada: claveOriginalLimpia,
    emisorNombre: emisorNombre || cedulaLimpia,
    receptorNombre: receptor ? receptor.nombre : null,
    receptorCedula: receptor && receptor.identificacion ? receptor.identificacion.numero : null,
    receptorEmail: receptor ? receptor.correoElectronico : null,
    total: resumen.totalComprobante, lineas, condicionVenta: condicionVenta || '01',
    medioPago: medioPago || ['01'], xmlFirmadoBase64,
  }, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  return jsonResponse({
    ok: true, aceptado: resultado.accepted, pendiente: resultado.pending === true,
    motivoRechazo: resultado.accepted === false ? resultado.rejectionReason : null,
    mensajePendiente: resultado.pending === true ? 'Hacienda no confirmó a tiempo (55s), pero la nota de crédito SÍ fue recibida. Guardá la clave para consultar más tarde.' : null,
    clave, numeroConsecutivo, claveReferenciada: claveOriginalLimpia, ambiente: entorno, xmlFirmadoBase64,
  })
}

// POST /emitir-nota-debito
async function handleNotaDebito(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const { idToken, claveOriginal, fechaOriginal, motivo, receptor, lineas, condicionVenta, medioPago, esTiquete, emisorNombre, cedulaEmisor: cedulaEmisorBody } = body || {}

  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('nota-debito:' + uid, 10, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Alcanzaste el límite de notas de débito por hora.' }, 429)
  if (!claveOriginal || soloDigitos(claveOriginal).length !== 50) return jsonResponse({ error: 'Falta o es inválida la clave del documento original (50 dígitos).' }, 400)
  if (!Array.isArray(lineas) || !lineas.length) return jsonResponse({ error: 'Faltan datos: lineas es obligatorio.' }, 400)
  if (!esTiquete && !receptor) return jsonResponse({ error: 'Para una nota de débito sobre Factura hace falta el receptor.' }, 400)

  const cedulaEmisorParaCert = soloDigitos(cedulaEmisorBody || '') || cedulaDeClave(claveOriginal) || undefined
  const { ok, datosCert } = await obtenerCertificado(uid, cedulaEmisorParaCert, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener el certificado: ' + (datosCert.error || 'error desconocido') }, 502)

  const { certificadoBase64, contrasena: p12Pin, cedulaEmisor, usuarioHacienda, passwordHacienda, actividadEconomica, ambiente } = datosCert
  if (!certificadoBase64 || !cedulaEmisor || !usuarioHacienda || !passwordHacienda || !actividadEconomica)
    return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const p12Buffer = Buffer.from(certificadoBase64, 'base64')
  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  const tipoIdEmisor = tipoIdentificacionEmisor(cedulaLimpia)
  const claveOriginalLimpia = soloDigitos(claveOriginal)

  const secuencia = await obtenerSiguienteSecuencia(uid, 'notaDebito', cedulaLimpia, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  const { lineasCalculadas, resumen } = calcularResumen(lineas)
  resumen.medioPago = [{ tipoMedioPago: (Array.isArray(medioPago) && medioPago[0]) || '01', totalMedioPago: resumen.totalComprobante }]

  const clave = buildClave({ date: new Date(), taxpayerId: cedulaLimpia, documentType: DocumentType.NOTA_DEBITO_ELECTRONICA, sequence: secuencia, situation: Situation.NORMAL })
  const numeroConsecutivo = SUCURSAL + TERMINAL + '02' + String(secuencia).padStart(10, '0')

  const documento = {
    clave, codigoActividadEmisor: limpio(actividadEconomica), proveedorSistemas: cedulaLimpia,
    numeroConsecutivo, fechaEmision: new Date().toISOString(),
    emisor: armarEmisor(datosCert, emisorNombre),
    receptor: receptor || { nombre: 'Consumidor final', identificacion: { tipo: '01', numero: cedulaLimpia } },
    condicionVenta: condicionVenta || '01', detalleServicio: lineasCalculadas, resumenFactura: resumen,
    informacionReferencia: [{
      tipoDoc: esTiquete ? '04' : '01', numero: claveOriginalLimpia,
      fechaEmision: fechaOriginal || new Date().toISOString(),
      codigo: '04', razon: limpio(motivo).slice(0, 180) || 'Cargo adicional sobre el comprobante de referencia',
    }],
  }

  const xml = buildNotaDebitoXml(documento)
  const xmlFirmadoBase64 = await signAndEncode(xml, p12Buffer, p12Pin)
  const baseUrl = entorno === 'production' ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1' : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'
  const resultado = await enviarYEsperarDirecto({ baseUrl, entorno, usuario: usuarioHacienda, password: passwordHacienda, clave, tipoIdEmisor, cedulaEmisor: cedulaLimpia, comprobanteXml: xmlFirmadoBase64 })

  const estadoHistorial = resultado.accepted === true ? 'aceptado' : resultado.accepted === false ? 'rechazado' : 'pendiente'
  await guardarHistorial(uid, {
    clave, numeroConsecutivo, ambiente: entorno, estado: estadoHistorial,
    motivoRechazo: estadoHistorial === 'rechazado' ? resultado.rejectionReason : null,
    fecha: new Date().toISOString(), tipoDocumento: 'notaDebito', claveReferenciada: claveOriginalLimpia,
    emisorNombre: emisorNombre || cedulaLimpia,
    receptorNombre: receptor ? receptor.nombre : null,
    receptorCedula: receptor && receptor.identificacion ? receptor.identificacion.numero : null,
    receptorEmail: receptor ? receptor.correoElectronico : null,
    total: resumen.totalComprobante, lineas, condicionVenta: condicionVenta || '01',
    medioPago: medioPago || ['01'], xmlFirmadoBase64,
  }, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  return jsonResponse({
    ok: true, aceptado: resultado.accepted, pendiente: resultado.pending === true,
    motivoRechazo: resultado.accepted === false ? resultado.rejectionReason : null,
    mensajePendiente: resultado.pending === true ? 'Hacienda no confirmó a tiempo (55s), pero la nota de débito SÍ fue recibida. Guardá la clave para consultar más tarde.' : null,
    clave, numeroConsecutivo, claveReferenciada: claveOriginalLimpia, ambiente: entorno, xmlFirmadoBase64,
  })
}

// POST /emitir-mensaje-receptor
async function handleMensajeReceptor(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const { idToken, claveRecibida, cedulaEmisorRecibido, fechaEmisionRecibida, totalFacturaRecibida, montoTotalImpuestoRecibido, mensaje, detalleMensaje, cedulaEmisor: cedulaEmisorBody } = body || {}

  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('mensaje-receptor:' + uid, 20, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Alcanzaste el límite de mensajes de receptor por hora.' }, 429)

  const claveRecibidaLimpia = soloDigitos(claveRecibida)
  if (claveRecibidaLimpia.length !== 50) return jsonResponse({ error: 'Falta o es inválida la clave del comprobante recibido (50 dígitos).' }, 400)
  const codigoConsecutivo = CODIGO_CONSECUTIVO_POR_MENSAJE[String(mensaje)]
  if (!codigoConsecutivo) return jsonResponse({ error: 'El mensaje debe ser "1" (acepta), "2" (acepta parcial) o "3" (rechaza).' }, 400)
  const cedulaEmisorRecibidoLimpia = soloDigitos(cedulaEmisorRecibido)
  if (!cedulaEmisorRecibidoLimpia) return jsonResponse({ error: 'Falta la cédula de quien emitió el comprobante que estás respondiendo.' }, 400)

  const { ok, datosCert } = await obtenerCertificado(uid, soloDigitos(cedulaEmisorBody || '') || undefined, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener el certificado: ' + (datosCert.error || 'error desconocido') }, 502)

  const { certificadoBase64, contrasena: p12Pin, cedulaEmisor, usuarioHacienda, passwordHacienda, ambiente } = datosCert
  if (!certificadoBase64 || !cedulaEmisor || !usuarioHacienda || !passwordHacienda)
    return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const p12Buffer = Buffer.from(certificadoBase64, 'base64')
  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  const tipoIdPropio = tipoIdentificacionEmisor(cedulaLimpia)

  const secuencia = await obtenerSiguienteSecuencia(uid, 'mensajeReceptor-' + codigoConsecutivo, cedulaLimpia, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  const numeroConsecutivoReceptor = SUCURSAL + TERMINAL + codigoConsecutivo + String(secuencia).padStart(10, '0')

  const documento = {
    clave: claveRecibidaLimpia, numeroCedulaEmisor: cedulaEmisorRecibidoLimpia,
    fechaEmisionDoc: fechaEmisionRecibida || new Date().toISOString(),
    mensaje: String(mensaje), detalleMensaje: limpio(detalleMensaje).slice(0, 160) || undefined,
    montoTotalImpuesto: Number(montoTotalImpuestoRecibido) || 0,
    totalFactura: Number(totalFacturaRecibida) || 0,
    numeroCedulaReceptor: cedulaLimpia, numeroConsecutivoReceptor,
  }

  const xml = buildMensajeReceptorXml(documento)
  const xmlFirmadoBase64 = await signAndEncode(xml, p12Buffer, p12Pin)
  const baseUrl = entorno === 'production' ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1' : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'
  const resultado = await enviarYEsperarDirecto({ baseUrl, entorno, usuario: usuarioHacienda, password: passwordHacienda, clave: claveRecibidaLimpia, tipoIdEmisor: tipoIdPropio, cedulaEmisor: cedulaLimpia, comprobanteXml: xmlFirmadoBase64 })

  const estadoHistorial = resultado.accepted === true ? 'aceptado' : resultado.accepted === false ? 'rechazado' : 'pendiente'
  await guardarHistorial(uid, {
    clave: claveRecibidaLimpia, numeroConsecutivo: numeroConsecutivoReceptor, ambiente: entorno, estado: estadoHistorial,
    motivoRechazo: estadoHistorial === 'rechazado' ? resultado.rejectionReason : null,
    fecha: new Date().toISOString(), tipoDocumento: 'mensajeReceptor', claveReferenciada: claveRecibidaLimpia,
    mensajeReceptorTipo: String(mensaje), receptorNombre: null, receptorCedula: cedulaEmisorRecibidoLimpia,
    receptorEmail: null, total: Number(totalFacturaRecibida) || 0, xmlFirmadoBase64,
  }, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  return jsonResponse({
    ok: true, aceptado: resultado.accepted, pendiente: resultado.pending === true,
    motivoRechazo: resultado.accepted === false ? resultado.rejectionReason : null,
    mensajePendiente: resultado.pending === true ? 'Hacienda no confirmó a tiempo (55s), pero el mensaje SÍ fue recibido. Guardá la clave para consultar más tarde.' : null,
    numeroConsecutivoReceptor, claveReferenciada: claveRecibidaLimpia, ambiente: entorno, xmlFirmadoBase64,
  })
}

// POST /emitir-recibo-pago
async function handleReciboPago(body, env) {
  const CERTIFICADOS_WORKER_URL = (env.CERTIFICADOS_WORKER_URL || 'https://matriz-certificados.kacn1z.workers.dev').trim().replace(/\/+$/, '')
  const { FIRMA_SERVICE_SECRET, FIREBASE_API_KEY } = env

  if (!FIRMA_SERVICE_SECRET) return jsonResponse({ error: 'Falta configurar FIRMA_SERVICE_SECRET.' }, 500)

  const { idToken, claveOriginal, fechaOriginal, receptor, lineas, medioPago, emisorNombre, montoPago, totalOriginal, cedulaEmisor: cedulaEmisorBody } = body || {}

  const uid = await verificarIdToken(idToken, FIREBASE_API_KEY)
  if (!uid) return jsonResponse({ error: 'Sesión inválida o expirada.' }, 401)
  if (!(await verificarLimiteRemoto('recibo-pago:' + uid, 20, 3600, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)))
    return jsonResponse({ error: 'Alcanzaste el límite de recibos de pago por hora.' }, 429)
  if (!claveOriginal || soloDigitos(claveOriginal).length !== 50) return jsonResponse({ error: 'Falta o es inválida la clave de la factura original (50 dígitos).' }, 400)
  if (!Array.isArray(lineas) || !lineas.length) return jsonResponse({ error: 'Faltan datos: lineas es obligatorio.' }, 400)
  if (!receptor) return jsonResponse({ error: 'Falta el receptor — un REP siempre referencia una Factura a crédito que tiene receptor.' }, 400)

  const cedulaEmisorParaCert = soloDigitos(cedulaEmisorBody || '') || cedulaDeClave(claveOriginal) || undefined
  const { ok, datosCert } = await obtenerCertificado(uid, cedulaEmisorParaCert, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)
  if (!ok) return jsonResponse({ error: 'No se pudo obtener el certificado: ' + (datosCert.error || 'error desconocido') }, 502)

  const { certificadoBase64, contrasena: p12Pin, cedulaEmisor, usuarioHacienda, passwordHacienda, actividadEconomica, ambiente } = datosCert
  if (!certificadoBase64 || !cedulaEmisor || !usuarioHacienda || !passwordHacienda || !actividadEconomica)
    return jsonResponse({ error: 'Este usuario todavía no completó su configuración de Hacienda.' }, 400)

  const p12Buffer = Buffer.from(certificadoBase64, 'base64')
  const entorno = ambiente === 'production' ? 'production' : 'sandbox'
  const cedulaLimpia = soloDigitos(cedulaEmisor)
  const tipoIdEmisor = tipoIdentificacionEmisor(cedulaLimpia)
  const claveOriginalLimpia = soloDigitos(claveOriginal)

  const secuencia = await obtenerSiguienteSecuencia(uid, 'reciboPago', cedulaLimpia, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  // Escalar líneas si es pago parcial
  let lineasBase = lineas
  const montoPagoNum = Number(montoPago)
  const totalOrigNum = Number(totalOriginal)
  if (montoPago !== undefined && montoPago !== null && montoPago !== '') {
    if (!(montoPagoNum > 0) || !(totalOrigNum > 0) || montoPagoNum > totalOrigNum + 0.005)
      return jsonResponse({ error: 'El monto del pago debe ser mayor que 0 y no puede superar el total de la factura.' }, 400)
    if (montoPagoNum < totalOrigNum - 0.005) {
      const proporcion = montoPagoNum / totalOrigNum
      lineasBase = lineas.map(l => ({ ...l, precioUnitario: Math.round(Number(l.precioUnitario) * proporcion * 100000) / 100000 }))
    }
  }

  const { lineasCalculadas, resumen } = calcularResumen(lineasBase)
  resumen.medioPago = [{ tipoMedioPago: (Array.isArray(medioPago) && medioPago[0]) || '01', totalMedioPago: resumen.totalComprobante }]

  const claveSdk = buildClave({ date: new Date(), taxpayerId: cedulaLimpia, documentType: DocumentType.RECIBO_ELECTRONICO_PAGO, sequence: secuencia, situation: Situation.NORMAL })
  const numeroConsecutivo = SUCURSAL + TERMINAL + '10' + String(secuencia).padStart(10, '0')
  const clave = claveSdk.slice(0, 21) + numeroConsecutivo + claveSdk.slice(41)
  if (clave.length !== 50) return jsonResponse({ error: 'No se pudo armar la clave del recibo de pago.' }, 500)

  const documento = {
    clave, codigoActividadEmisor: limpio(actividadEconomica), proveedorSistemas: cedulaLimpia,
    numeroConsecutivo, fechaEmision: new Date().toISOString(),
    emisor: armarEmisor(datosCert, emisorNombre),
    receptor, condicionVenta: '01', detalleServicio: lineasCalculadas, resumenFactura: resumen,
    informacionReferencia: [{
      tipoDoc: '01', numero: claveOriginalLimpia,
      fechaEmision: fechaOriginal || new Date().toISOString(),
      codigo: '04', razon: 'Pago de la factura de referencia',
    }],
  }

  const xml = buildReciboPagoXml(documento)
  const xmlFirmadoBase64 = await signAndEncode(xml, p12Buffer, p12Pin)
  const baseUrl = entorno === 'production' ? 'https://api.comprobanteselectronicos.go.cr/recepcion/v1' : 'https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1'
  const resultado = await enviarYEsperarDirecto({ baseUrl, entorno, usuario: usuarioHacienda, password: passwordHacienda, clave, tipoIdEmisor, cedulaEmisor: cedulaLimpia, comprobanteXml: xmlFirmadoBase64 })

  const estadoHistorial = resultado.accepted === true ? 'aceptado' : resultado.accepted === false ? 'rechazado' : 'pendiente'
  await guardarHistorial(uid, {
    clave, numeroConsecutivo, ambiente: entorno, estado: estadoHistorial,
    motivoRechazo: estadoHistorial === 'rechazado' ? resultado.rejectionReason : null,
    fecha: new Date().toISOString(), tipoDocumento: 'reciboPago', claveReferenciada: claveOriginalLimpia,
    emisorNombre: emisorNombre || cedulaLimpia,
    receptorNombre: receptor ? receptor.nombre : null,
    receptorCedula: receptor && receptor.identificacion ? receptor.identificacion.numero : null,
    receptorEmail: receptor ? receptor.correoElectronico : null,
    total: resumen.totalComprobante, lineas, medioPago: medioPago || ['01'], xmlFirmadoBase64,
  }, CERTIFICADOS_WORKER_URL, FIRMA_SERVICE_SECRET)

  return jsonResponse({
    ok: true, aceptado: resultado.accepted, pendiente: resultado.pending === true,
    motivoRechazo: resultado.accepted === false ? resultado.rejectionReason : null,
    mensajePendiente: resultado.pending === true ? 'Hacienda no confirmó a tiempo (55s), pero el recibo de pago SÍ fue recibido. Guardá la clave para consultar más tarde.' : null,
    clave, numeroConsecutivo, claveReferenciada: claveOriginalLimpia, ambiente: entorno, xmlFirmadoBase64,
  })
}

// ─── Router principal ────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    // OPTIONS (preflight CORS)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Método no permitido, usá POST.' }, 405)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'JSON inválido.' }, 400)
    }

    const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'sin-ip'

    try {
      if (path === '/firmar-factura') return await handleFirmarFactura(body, env)
      if (path === '/consultar-estado') return await handleConsultarEstado(body, env)
      if (path === '/enviar-correo-factura') return await handleEnviarCorreo(body, env, clientIp)
      if (path === '/emitir-nota-credito') return await handleNotaCredito(body, env)
      if (path === '/emitir-nota-debito') return await handleNotaDebito(body, env)
      if (path === '/emitir-mensaje-receptor') return await handleMensajeReceptor(body, env)
      if (path === '/emitir-recibo-pago') return await handleReciboPago(body, env)

      return jsonResponse({ error: 'Ruta no encontrada: ' + path }, 404)
    } catch (err) {
      console.error('Error en ' + path + ':', err)
      return jsonResponse({ error: 'Error interno: ' + (err && err.message ? err.message : String(err)) }, 500)
    }
  },
}
