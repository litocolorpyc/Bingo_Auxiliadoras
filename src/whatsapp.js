// Envío de tablas por WhatsApp Cloud API (Meta).
// Sin credenciales configuradas, devuelve un enlace wa.me para enviar a mano.

function crearWhatsApp({ token, phoneId, plantilla, idioma = 'es', codigoPais = '58', fetchFn = fetch } = {}) {
  const configurado = Boolean(token && phoneId);

  function normalizarTelefono(texto) {
    const digitos = String(texto || '').replace(/\D/g, '');
    const numero = digitos.startsWith('0') ? codigoPais + digitos.slice(1) : digitos;
    if (numero.length < 8 || numero.length > 15) throw new Error('El número de WhatsApp no es válido.');
    return numero;
  }

  function mensajeTablas(nombre, seriales) {
    const lista = seriales.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return `Hola ${nombre}, tu pago fue verificado. Estas son tus tablas de bingo:\n${lista}\n¡Gracias por tu compra!`;
  }

  function enlaceManual(telefono, nombre, seriales) {
    const numero = normalizarTelefono(telefono);
    return `https://wa.me/${numero}?text=${encodeURIComponent(mensajeTablas(nombre, seriales))}`;
  }

  // Devuelve { estado: 'enviado' | 'manual', enlace? } o lanza error si la API rechaza el envío.
  async function enviarTablas({ telefono, nombre, seriales }) {
    if (!configurado) return { estado: 'manual', enlace: enlaceManual(telefono, nombre, seriales) };

    const to = normalizarTelefono(telefono);
    const texto = seriales.join(', ');
    const cuerpo = plantilla
      ? {
          type: 'template',
          template: {
            name: plantilla,
            language: { code: idioma },
            components: [{ type: 'body', parameters: [{ type: 'text', text: nombre }, { type: 'text', text: texto }] }],
          },
        }
      : { type: 'text', text: { body: mensajeTablas(nombre, seriales) } };

    const res = await fetchFn(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, ...cuerpo }),
    });
    if (!res.ok) {
      const detalle = await res.text();
      throw new Error(`WhatsApp respondió ${res.status}: ${detalle.slice(0, 300)}`);
    }
    return { estado: 'enviado' };
  }

  return { configurado, enviarTablas, enlaceManual, mensajeTablas, normalizarTelefono };
}

module.exports = { crearWhatsApp };
