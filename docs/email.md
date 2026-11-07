# Correo e Instinct (M3)

Guía para Lucas. **G1 todavía no se hizo y no hubo ningún correo real**: todo se probó con webhooks firmados falsos y una API de Resend simulada. Lo marcado **[G1]** es un supuesto que falta confirmar.

## Cómo funciona

| Función | Mecanismo |
|---|---|
| A quién va | La dirección: `bridge+<token>@` es una respuesta, `bridge+grok@` es una delegación |
| Quién lo autorizó | Remitente en lista permitida, veredictos SPF, DKIM y DMARC en `pass`, y el token HMAC en las respuestas |
| A qué tarea pertenece | El flag `[task:xxxxxxxx]` del asunto. Solo correlaciona: nunca autoriza nada |

**Puente hacia Instinct.** El correo va a `INSTINCT_EMAIL` con Lucas en copia. El `Reply-To` lleva el token firmado, y el pedido y la memoria van etiquetados como datos, cada uno en una línea. Si la tarea contiene un secreto, no sale: queda `failed` con una alerta. Si el secreto está en la memoria, sale sin ese contexto. Una tarea `side_effect` no se envía sin aprobación.

**Respuesta de Instinct.** Cierra la tarea con `finishTask`. Cada línea `MEMORY: clave = valor` pasa por `memoryWrite`, como hecho `unverified` con origen. El texto siempre queda en un evento `email_reply`. Sin líneas `MEMORY:` no se crea ningún hecho. Cada tarea acepta una sola respuesta.

**Delegación de Instinct.** Un correo a `bridge+grok@` crea una tarea con `createTask`, con sus frenos de saltos, tope diario y duplicados. El puente fija `to_agent`, el intent `research` y por lo tanto el riesgo: el contenido del correo no los elige. Un texto de más de 10.000 caracteres no cumple la política y queda como `side_effect`, esperando aprobación. Cuando la tarea termina, el resultado vuelve por el mismo hilo, sin token, así que responderlo no crea nada. Una tarea rechazada por los frenos no manda correo, para no alimentar un bucle.

## Proveedor: Resend

| | Resend | Mailgun | Postmark | SendGrid | Amazon SES |
|---|---|---|---|---|---|
| Entrada por webhook | Sí, solo metadatos; el cuerpo se pide a la API | Sí, con el cuerpo | Sí, con el cuerpo | Sí, multipart | No directo: SNS, S3 o Lambda |
| Webhook firmado | Sí (Svix, HMAC sobre todo el cuerpo) | Sí. En form firma solo `timestamp` y `token`; en JSON, el cuerpo | **No**: Basic Auth e IP | Sí (ECDSA, con política aparte) | SNS firmado con certificado |
| Veredictos | Sí: `authentication.spf`, `dkim`, `dmarc`, documentados | Anunciados en mayo de 2026, sin nombres de campo documentados | Solo cabeceras de SpamAssassin, sin DMARC | `SPF` y `dkim`, sin DMARC como campo | Sí: los más completos |
| Hilos | `message_id`, `In-Reply-To` y `References` documentados | Por cabeceras | Por cabeceras | Por cabeceras | Hay que parsear MIME |
| Gratis | 100 al día, 3.000 al mes, con entrada incluida | 100 al día, 1 ruta de entrada, 1 día de registros | No revisado: descartado | No revisado | No revisado |

**Por qué Resend:** es el único con webhook firmado y veredictos DKIM y DMARC documentados en un JSON simple, sin AWS ni parseo de MIME. Sirve en serverless porque el webhook es corto. **Plan B:** SES, si Resend falla en la prueba real. Mailgun queda como alternativa solo si documenta los campos.

Límites de Resend: cada correo recibido cuenta en la cuota, y como el dominio recibe en cualquier dirección, el spam también gasta. Por eso conviene usar un subdominio poco visible. La API permite 10 solicitudes por segundo. No se usa el SDK: una verificación de firma y tres llamadas no justifican una dependencia.

El cambio de proveedor se limita a `EmailProvider` en `src/email.ts`: `parseWebhook`, `fetchInbound` y `send`.

## Variables

Sin las siete, el adaptador no carga y las tareas de Instinct quedan en cola sin gastar intentos.

| Variable | Qué es |
|---|---|
| `RESEND_API_KEY` | Clave de la API. Enviar y leer lo recibido |
| `RESEND_WEBHOOK_SECRET` | Secreto de firma del webhook, `whsec_...` |
| `EMAIL_DOMAIN` | Subdominio del puente, por ejemplo `bridge.tudominio.com` |
| `EMAIL_TOKEN_SECRET` | Aleatorio, 32 caracteres o más: `openssl rand -hex 32` |
| `INSTINCT_EMAIL` | Dirección a la que el puente le escribe a Instinct |
| `EMAIL_ALLOWED_SENDERS` | Direcciones desde las que Instinct escribe, separadas por comas. Coincidencia exacta. La de Lucas se rechaza al arrancar |
| `LUCAS_EMAIL` | Va en copia de todo. No hay opción para quitarla |

Rotar `EMAIL_TOKEN_SECRET` invalida los tokens de las tareas abiertas: sus respuestas irán a cuarentena hasta que venzan, a las 24 h.

## Esquema

`db/004_email.sql` es aditivo y **no está aplicado en vivo**. Se aplica con `pnpm db:migrate`, previo backup.

- Registra `instinct` con el adaptador `email`, sin tocar `enabled`, que es el kill switch.
- `email_inbound`: una fila por correo recibido, con su estado y motivo. La clave `(provider, provider_id)` hace idempotente la reentrega. No guarda cuerpos: el de un correo en cuarentena queda solo en Resend (30 días en el plan gratis).
- `email_outbound`: lo enviado, para el hilo y la auditoría.

## Cuarentena

Un webhook sin firma válida recibe `401` y no deja nada. Uno firmado cuyo correo no pasa los controles recibe `200`, para que el proveedor no reintente, y queda en cuarentena sin parsearse.

```sql
SELECT received_at, reason, sender, subject, verdicts, provider_id
FROM bridge.email_inbound WHERE status = 'quarantined' ORDER BY received_at DESC LIMIT 50;
```

| Motivo | Significa |
|---|---|
| `sender_not_allowed` | Remitente fuera de la lista, o `From` ambiguo |
| `auth_failed` | SPF, DKIM o DMARC distinto de `pass`, o sin veredicto |
| `no_token` | Sin `bridge+...`: por ejemplo, respondió a `From` en vez de `Reply-To` |
| `invalid_token` | Token alterado, o destino de delegación no permitido |
| `ambiguous_route` | Más de un `bridge+...` distinto |
| `no_text_body` | Sin parte de texto plano |
| `too_large`, `invalid_text` | Más de 64.000 caracteres, o con caracteres NUL |
| `secret` | El filtro de secretos encontró algo. Puede ser falso positivo, como un hash largo |
| `task_not_open` | La tarea venció, se cerró o ya tuvo su respuesta |
| `task_refused:<código>` | `createTask` rechazó la delegación |

Nada sale de cuarentena solo. Para revisar un cuerpo, míralo en Resend con `provider_id`.

## Qué debe confirmar G1

Las pruebas son las de la sección 11 del PRD. El adaptador depende además de estos puntos:

1. **[G1]** ¿Instinct responde a correo automatizado de un remitente que no es Lucas? Si no, M3 no sirve y toca el plan B de la sección 7.
2. **[G1]** ¿Responde al `Reply-To`, conservando el `+token` exacto? Si responde a `From`, todo cae en `no_token`.
3. **[G1]** ¿Desde qué dirección escribe? ¿Es la misma a la que se le envía? Define `EMAIL_ALLOWED_SENDERS`.
4. **[G1]** ¿Sus correos llegan con SPF, DKIM y DMARC en `pass`? El control es estricto. Si DMARC llega `gray` porque su dominio usa `p=none`, todo cae en `auth_failed`. Relajarlo es una decisión de seguridad, no un ajuste: requiere que lo apruebes.
5. **[G1]** ¿Envía una parte `text/plain`? Si solo manda HTML, todo cae en `no_text_body`.
6. **[G1]** ¿Respeta `MEMORY:` al inicio de la línea, en 5 de 5, sin viñetas ni negritas? El parser no lo adivina: esas líneas no crean hechos. Mira `memory_lines` en `email_reply` para la regla del 20 % de la sección 7.
7. **[G1]** ¿Manda una sola respuesta por tarea? La primera cierra la tarea. Un "te aviso cuando termine" cerraría la tarea con ese texto, y la respuesta real iría a cuarentena.
8. **[G1]** ¿Puede escribir por su cuenta a `bridge+grok@`? ¿Conserva el `+` en la dirección? ¿Mantiene el hilo cuando se le responde?
9. **[G1]** ¿Obedece lo que llega como dato (prueba 5, PLÁTANO)? Si sí, el riesgo es real y `side_effect` no se relaja.
10. Los términos no aclaran el envío automatizado. El borrador para `comms@instinct.com` de la sección 7 lo envías tú.

## Lo que requiere un buzón real

Nada de esto se probó. Hazlo con un buzón de prueba como remitente permitido, nunca el tuyo, antes de usar a Instinct:

1. Que Resend entregue `bridge+<52 caracteres>@` y `bridge+grok@` al webhook. Su documentación dice "cualquier dirección del dominio", sin mencionar el `+`.
2. Que el payload real coincida con su referencia, y que `authentication` traiga los tres veredictos. `headers.from` debe coincidir con `from`, también con nombres codificados, o el correo cae en `sender_not_allowed`.
3. Que un correo falsificado desde un dominio ajeno llegue con el veredicto correcto y quede en cuarentena.
4. Que `GET /emails/{id}` ya tenga `message_id` justo después de enviar. Si no, solo se pierde el hilo de la siguiente tarea, no la respuesta.
5. Que `In-Reply-To` y `References` agrupen el hilo en un cliente real, y que Lucas reciba la copia.
6. La firma real de un webhook, y un reintento forzado respondiendo `503`.

Este es el criterio de M3 "ida y vuelta real con buzón de prueba", y sigue pendiente.

## Pasos a mano

1. G1, en especial los puntos de arriba.
2. Cuenta de Resend y subdominio dedicado, con sus registros DNS de envío y el MX de recepción.
3. Webhook de `email.received` hacia `https://<host>/webhooks/email`, sin protección de despliegue en esa URL.
4. Las variables de arriba en el host, y `pnpm db:migrate`.
5. La prueba con buzón real.
6. El opt-out en `app.instinct.com/settings`, y enseñarle a Instinct el texto de `/activate/instinct`.

## Límites conocidos

- **Vercel Hobby:** su cron corre solo una vez al día, así que el envío depende de `POST /cron/dispatch` por minuto desde `db/cron_dispatch.sql` (pg_cron en Supabase, ver el runbook). Sin ese paso manual, una tarea para Instinct o un resultado puede no salir. Cada pasada también envía los resultados pendientes. La recepción no depende del cron.
- **El puente no controla a Instinct.** Controla lo que le pide, no lo que hace con sus cuentas. Un texto hostil en `research` sigue siendo texto: el destinatario debe tratarlo como dato.
- **Aprobaciones:** una tarea `side_effect` no sale sin una aprobación vigente en `approval`. La cola la retiene y el adaptador lo revisa otra vez. Sin aprobación, vence a las 24 h.
- **Una respuesta solo cierra como `completed`.** Por correo no hay forma de marcarla `failed`.
- **Hechos sobrescribibles:** una respuesta válida con una clave existente reemplaza el valor actual, como `unverified`, y el anterior queda en el historial. Un hecho `verified` no se puede reemplazar: esa línea se cuenta como rechazada.
- **Spam:** cada correo al dominio cuesta una llamada a la API, una fila y un evento. Sin retención automática.

## Nunca

Automatizar iMessage, WhatsApp o SMS desde tu cuenta. Hacer scraping o ingeniería inversa de `app.instinct.com`. Pasar credenciales, datos de clientes o datos de FreeTicket por este canal.

## Fuentes

Revisadas el 7-nov-2026. Resend: [recepción](https://resend.com/docs/dashboard/receiving/introduction), [correo recibido](https://resend.com/docs/api-reference/emails/retrieve-received-email), [evento `email.received`](https://resend.com/docs/webhooks/emails/received), [hilos](https://resend.com/docs/dashboard/receiving/reply-to-emails), [idempotencia](https://resend.com/docs/dashboard/emails/idempotency-keys), [reintentos](https://resend.com/docs/dashboard/webhooks/retries-and-replays), [precios](https://resend.com/pricing), [cuotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits). [Svix: verificación manual](https://docs.svix.com/receiving/verifying-payloads/how-manual). [Mailgun: entrada](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http), [firma](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks), [veredictos](https://www.mailgun.com/?p=13451), [precios](https://www.mailgun.com/pricing/). [Postmark: webhooks](https://postmarkapp.com/developer/webhooks/webhooks-overview). [SendGrid: Inbound Parse](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook), [firma](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks). [SES: notificaciones](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html). [Vercel: cron](https://vercel.com/docs/cron-jobs/usage-and-pricing).
