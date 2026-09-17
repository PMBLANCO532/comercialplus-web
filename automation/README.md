# Correo de inscripción tras Stripe

El receptor confirma por email la inscripción cuando Stripe comunica un pago completado y pagado del Payment Link de la mentoría. Verifica la firma de Stripe, comprueba el Payment Link, el total de 100 € y la moneda EUR, y evita duplicar correos por sesión de Checkout. No incluye el enlace ni la clave de Zoom; informa que se enviarán antes del primer encuentro.

## Configuración en el VPS

Guardar las variables en el gestor de secretos del servicio o en un archivo de entorno con permisos `0600`; nunca en Git:

- `STRIPE_WEBHOOK_SECRET`: secreto `whsec_...` del endpoint.
- `MENTOR_PAYMENT_LINK_ID`: identificador `plink_...` del Payment Link de la mentoría.
- `FROM_EMAIL`: opcional; por defecto `info@comercialplus.es`.
- `ENROLLMENT_NOTIFY_EMAIL`: opcional; copia oculta de cada inscripción confirmada para poder enviar el acceso a Zoom. Por defecto `info@comercialplus.es`.
- `PORT`: opcional; por defecto `8090`.
- `STATE_DIR`: opcional; por defecto `/var/lib/comercialplus-ia-webhook`.

El unit file `comercialplus-ia-webhook.service` configura el proceso con `www-data`, almacenamiento de estado aislado y protecciones de systemd. Este VPS instala `sendmail` con bit setuid; por eso el servicio no debe activar `NoNewPrivileges`, ya que impediría que Postfix acepte el mensaje. El fragmento `nginx-stripe-webhook.location` añade la ruta HTTPS a `127.0.0.1:8090`; debe incluirse dentro del bloque TLS de `ia.comercialplus.es`, antes de activarla.

Guardar las variables en `/etc/comercialplus-ia-webhook.env` con propietario `root:root` y modo `0600`. El unit file lee `STRIPE_WEBHOOK_SECRET` y `MENTOR_PAYMENT_LINK_ID`; no lleva secretos incorporados. En Stripe, configurar el endpoint para `checkout.session.completed` y `checkout.session.async_payment_succeeded`, y guardar el secreto de firma directamente en el VPS. No incluirlo en conversaciones, archivos versionados, logs ni respuestas de diagnóstico.

Antes de conectar Stripe: respaldar el archivo Nginx actual, instalar el servicio, validar con `nginx -t` y recargar Nginx solo si la validación pasa. Verificar primero la ruta con un evento firmado que no corresponda a una compra (debe responder `ignored`, sin email). La entrega de correo se prueba con un Payment Link y un webhook de prueba de Stripe en modo test y una dirección de prueba controlada; no se debe hacer un pago real de 100 € como test. Nunca incluir el acceso real de Zoom en las pruebas.

## Validación local

Con Node.js 18 o posterior, ejecutar:

```sh
node --test automation/stripe-webhook.test.js
```

Las pruebas usan una clave de firma ficticia, correo simulado y una carpeta temporal; no envían emails ni requieren credenciales reales. La confirmación se envía al comprador y en copia oculta a `ENROLLMENT_NOTIFY_EMAIL`, para que Comercial Plus reciba su nombre y correo sin revelar esa dirección al participante.
