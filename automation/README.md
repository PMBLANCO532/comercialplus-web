# Automatización de inscripción tras Stripe

Este receptor procesa `checkout.session.completed` solo cuando el pago figura como `paid`, verifica la firma `Stripe-Signature`, evita duplicados y envía el acceso por Postfix.

Variables necesarias en el VPS (nunca en Git):

- `STRIPE_WEBHOOK_SECRET`: secreto `whsec_...` del endpoint de Stripe.
- `ZOOM_JOIN_URL`: enlace definitivo de la reunión.
- `ZOOM_PASSCODE`: opcional.
- `FROM_EMAIL`: opcional; por defecto `info@comercialplus.es`.
- `STATE_DIR`: opcional; por defecto `/var/lib/comercialplus-ia-webhook`.

Ruta esperada del endpoint: `POST /stripe/webhook`. Antes de activarlo hay que configurar el endpoint en Stripe y probar un evento firmado.
