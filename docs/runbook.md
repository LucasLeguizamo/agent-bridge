# Runbook de agent-bridge

Corre en Vercel Hobby, con funciones en `pdx1`, y Postgres en el proyecto dedicado de Supabase en `aws-1-us-west-2`. Nunca el de FreeTicket.
Desplegar, migrar producción, rotar claves o cambiar DNS lo hace Lucas, o requiere su aprobación explícita.

**Pendiente antes de M5:** la restauración de abajo está escrita pero no probada. El PRD exige una prueba real.

**Alertas:** hoy son solo filas en `event`. Nadie recibe un aviso, y si el puente cae no se escribe ninguna. Hay que revisarlas a mano.

**Activar agentes:** `/activate/grok` y `/activate/instinct`, en la URL de producción, dan los pasos con la URL de ese despliegue. Son públicas y no tienen claves ni tocan la base. Guías completas: `docs/grok-routine.md` y `docs/email.md`.

## Variables de entorno

Solo los nombres. Los valores nunca van al repo ni al chat.

| Dónde | Variables |
|---|---|
| Vercel, solo **Production** | `DATABASE_URL`, `BRIDGE_AGENT_KEYS`, `CRON_SECRET` |
| Vercel, solo **Production**, opcional | `DATABASE_CA_PEM`, `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_DOMAIN`, `EMAIL_TOKEN_SECRET`, `INSTINCT_EMAIL`, `EMAIL_ALLOWED_SENDERS`, `LUCAS_EMAIL` |
| Supabase Vault | `bridge_url`, `bridge_cron_secret` |
| Solo en `.env.local`, nunca en Vercel | `ADMIN_DATABASE_URL`, `BRIDGE_DB_PASSWORD`, `TEST_DATABASE_URL` |

Solo Production a propósito: un preview sin variables responde 500 en vez de hablar con la base real. Sin las dos de Grok, o sin las siete de correo, ese adaptador no carga y sus tareas quedan en cola sin gastar intentos. Cambiar una variable no afecta a lo que ya está desplegado: hay que volver a desplegar.

## TLS de la base

`sslmode=require` cifra pero no comprueba quién responde. Supabase entrega su CA solo desde el dashboard, con sesión iniciada, así que el repo no la trae.

Para activar la verificación: Database > Settings > SSL Configuration > Download Certificate. Pegar el contenido en `DATABASE_CA_PEM` (no es secreto), en Vercel y en `.env.local`, y cambiar `DATABASE_URL` y `ADMIN_DATABASE_URL` a `sslmode=verify-full`. Con esa variable puesta, el puente y los scripts rechazan cualquier otro modo. **Sin probar:** no hubo acceso a la CA real, y solo se probó que un certificado incorrecto se rechaza contra el servidor real.

## Desplegar por primera vez

Cada paso depende del anterior. En especial, el webhook de Grok va al final porque la routine necesita la URL de `/mcp`, que no existe hasta desplegar.

1. **Backup** (abajo), si ya hay datos.

2. **Comprobar que `bridge` no está en Exposed schemas.** En Settings > Data API, "Exposed schemas" no debe incluirlo. Confirmar desde afuera, con la clave publicable:

   ```sh
   curl -s -H 'Accept-Profile: bridge' -H "apikey: $SUPABASE_PUBLISHABLE_KEY" "https://<ref>.supabase.co/rest/v1/agent"
   ```

   Debe responder el error `PGRST106`. Si devuelve filas o `[]`, detente: quita `bridge` de esa lista antes de seguir.

3. **Migrar:** `pnpm db:migrate`, con `ADMIN_DATABASE_URL` en `.env.local`. Cada archivo corre en una transacción y queda en `bridge.schema_migration`. En un proyecto nuevo, antes va `pnpm db:apply`.

   **Tiempos del rol**, una sola vez, con la URL de administrador. Un `statement_timeout` por conexión no pasa por el pooler en modo transacción, y sin esto el `query_timeout` del cliente no detiene la consulta en el servidor:

   ```sql
   ALTER ROLE bridge_app SET statement_timeout = '10s';
   ALTER ROLE bridge_app SET idle_in_transaction_session_timeout = '15s';
   ```

4. **Dar de alta a los agentes.** `bridge.agent` empieza vacía, y sin una fila cada agente recibe 403. Los ids deben coincidir con `BRIDGE_AGENT_KEYS`. Con `psql` y la URL de administrador (ver Backup para armar `LIBPQ_URL`):

   ```sh
   psql -d "$LIBPQ_URL" -c "INSERT INTO bridge.agent (id, adapter) VALUES ('grok', 'grok'), ('claude', 'http') ON CONFLICT (id) DO NOTHING"
   psql -d "$LIBPQ_URL" -c "SELECT id, adapter, enabled FROM bridge.agent ORDER BY id"
   ```

   Revisa el resultado: `ON CONFLICT DO NOTHING` deja sin cambios una fila con un adaptador equivocado. Debe decir `grok | grok | t`.

   **Instinct:** no le envíes tareas hasta completar M3 y cargar las variables de correo. `db/004_email.sql` ya registra la fila con adaptador `email`, y una tarea para un agente sin adaptador espera y termina `failed` a las 24 h.

5. **Crear el proyecto en Vercel** desde el repo, con preset Hono. El archivo de entrada es `src/index.ts`, y `vercel.json` fija la región. Cargar `DATABASE_URL`, `BRIDGE_AGENT_KEYS` y `CRON_SECRET` (`openssl rand -hex 32`) solo para Production.

6. **Protección de despliegues:** Settings > Deployment Protection > Vercel Authentication, con **Standard Protection** o "Only Preview Deployments" si aparece. Debe cubrir los previews y dejar abierto el dominio de producción: `pg_net` y Grok Bot no pueden iniciar sesión en Vercel. Nunca "All Deployments".

7. **Desplegar** y verificar. `<url>` es el dominio de producción:

   ```sh
   curl -fsS https://<url>/health                                  # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' https://<url>/tasks/x  # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<url>/cron/dispatch  # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://<url>/activate/grok  # 200
   ```

8. **Smoke test como `bridge_app`.** `/health` y un 401 no tocan permisos; esto sí. Hace una escritura, un reemplazo y una búsqueda con el código real, por el puerto 6543, en una transacción que siempre se revierte. Con `DATABASE_URL` en `.env.local`:

   ```sh
   pnpm db:smoke   # {"wrote":true,"superseded":true,"found":true,"rolled_back":true}
   ```

9. **Cron en Supabase.** En el SQL Editor, con los valores reales, y borrando después esa pestaña:

   ```sql
   SELECT vault.create_secret('https://<url>', 'bridge_url');
   SELECT vault.create_secret('<el mismo valor de CRON_SECRET>', 'bridge_cron_secret');
   ```

   `vault.create_secret` falla si el nombre ya existe: para cambiar un valor, usa `vault.update_secret` con su id, de `SELECT id, name FROM vault.secrets`.

   Después corre `db/cron_dispatch.sql` tal cual. Se puede repetir sin efecto: un `cron.schedule` con el mismo nombre reemplaza al anterior. Verifica al cabo de dos minutos:

   ```sql
   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'bridge-dispatch';
   SELECT status_code, left(content::text, 80), created FROM net._http_response ORDER BY created DESC LIMIT 3;
   ```

   Debe verse `200` con `{"status":"ok","claimed":0}`. Un `401` significa que el secreto no coincide con `CRON_SECRET`.

   Límite: `pg_net` deja el encabezado descifrado en `net.http_request_queue` hasta enviarlo, y cualquier rol con acceso a `pg_net` lo puede leer. Ese token solo dispara una pasada, y es rotable.

10. **Chequeo de disponibilidad:** un servicio externo que consulte `GET /health` cada 5 minutos o más. Responde 200 o 503 sin decir nada más. Vercel no reinicia nada por esto: solo sirve para avisarte. Cada consulta es una invocación y una lectura.

11. **Activar Grok Bot** según `/activate/grok`: con la URL ya creada se configura el MCP y la routine. Luego cargar `GROK_WEBHOOK_URL` y `GROK_WEBHOOK_KEY` y volver a desplegar. **G2 se hace aquí**, con un Bot de prueba.

## Desplegar después

1. Backup, si la versión trae migraciones.
2. Migrar **antes** de desplegar: las migraciones son aditivas, y el código nuevo puede necesitarlas.
3. `git push` a la rama de producción, o `vercel deploy --prod`.
4. Repetir las verificaciones del paso 7 y `pnpm db:smoke`.

Reglas para migraciones nuevas: `db/NNN_nombre.sql`, sin nombres de schema escritos a mano, sin `BEGIN` ni `COMMIT`, y con sus propios `GRANT` a `bridge_app`.

## Rollback

En Vercel, Deployments, elegir uno anterior y "Instant Rollback". En Hobby solo se puede volver al anterior.

Esto no revierte variables ni migraciones. Las migraciones van solo hacia adelante: para deshacer una, escribí otra o restaurá un backup.

## Límites de Hobby

| Recurso | Incluido por mes | Consumo estimado del cron |
|---|---|---|
| Invocaciones | 1.000.000 | 43.200 |
| Active CPU | 4 horas | Unas 0,2 h si la instancia sigue viva (15 ms por pasada). Unas 2,2 h si cada pasada fuera un arranque en frío (190 ms). Medido en un Mac, no en Vercel |
| Memoria provisionada | 360 GB-h | Unos 48 GB-h: 2 GB por unos 2 s por pasada, contando 1 s de cierre de conexiones. Estimado, no medido en Vercel |
| Duración por invocación | 300 s | Una pasada con entregas, unos 30 s en el peor caso habitual |
| Regiones | 1 | `pdx1` |
| Logs | 1 hora | Sin historial: mirar `event` para auditar |
| Cron de Vercel | 1 vez al día | Por eso el cron vive en Supabase |

- **Si se excede un límite, Vercel puede pausar el proyecto hasta 30 días.** Revisa Usage la primera semana. Si la CPU o la memoria llegan a la mitad, baja el cron a cada 2 o 5 minutos en `db/cron_dispatch.sql`: las tareas nuevas igual salen enseguida, y solo se atrasan los reintentos.
- Hobby es para uso personal y no comercial. Es el caso de este puente, y es otra razón para no meter nada de FreeTicket.
- Con el adaptador de correo cargado, cada pasada suma las consultas de sus resultados pendientes, aun sin trabajo.
- Los logs de una línea por pedido nunca llevan consulta ni cuerpo. `auth_failures` cuenta los 401 por instancia, y se reinicia con ella: sirve para ver un ataque en curso, no como total.

## Reiniciar o detener

No hay proceso que reiniciar. Para detener todo:

1. `SELECT cron.unschedule('bridge-dispatch');` detiene las pasadas por minuto. Para volver, corre otra vez `db/cron_dispatch.sql`.
2. Settings > General > "Pause Project" en Vercel apaga el servicio completo, también para los agentes.

## Kill switch

Se corre con `psql` y la URL de administrador. Toma efecto sin desplegar.

Apagar un agente. Su API responde 403 y el dispatcher deja de entregarle y de entregar lo suyo, y un `task_claim` de una tarea suya ya no se concede. Una entrega en curso termina, y los plazos siguen venciendo.

```sql
UPDATE bridge.agent SET enabled = false WHERE id = 'grok';
```

Volver a encenderlo:

```sql
UPDATE bridge.agent SET enabled = true WHERE id = 'grok';
```

Apagar todos:

```sql
UPDATE bridge.agent SET enabled = false;
```

Pausar un par de agentes una hora, también para `task_claim`. `agent_a` es el menor de los dos ids en orden alfabético:

```sql
INSERT INTO bridge.pair_pause (agent_a, agent_b, paused_until, reason)
VALUES (LEAST('grok', 'instinct'), GREATEST('grok', 'instinct'), now() + interval '1 hour', 'manual')
ON CONFLICT (agent_a, agent_b) DO UPDATE SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason;
```

Quitar la pausa:

```sql
DELETE FROM bridge.pair_pause WHERE agent_a = LEAST('grok', 'instinct') AND agent_b = GREATEST('grok', 'instinct');
```

## Leer alertas

Solo lectura, sin `SET` de sesión.

Alertas del último día. El campo `alert` vale `deadline_exceeded`, `delivery_exhausted`, `pair_paused` o `grok_breaker_open`:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload->>'alert' AS alert, payload
FROM bridge.event WHERE type = 'alert' AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Cola atascada. No genera una fila de alerta, hay que consultarla. Incluye las tareas de un agente sin adaptador cargado o apagado. Si está llena, revisa también que el cron corra:

```sql
BEGIN READ ONLY;
SELECT id, to_agent, attempts, next_attempt_at FROM bridge.task
WHERE state = 'submitted' AND next_attempt_at < now() - interval '5 minutes' ORDER BY next_attempt_at;
ROLLBACK;
```

Cortacircuitos activos:

```sql
BEGIN READ ONLY;
SELECT agent_a, agent_b, paused_until, reason FROM bridge.pair_pause WHERE paused_until > now();
SELECT adapter, paused_until, reason FROM bridge.adapter_pause WHERE paused_until > now();
ROLLBACK;
```

Fallos de entrega:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload FROM bridge.event
WHERE type = 'delivery_failed' AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Rechazos del filtro de secretos y escrituras sobre hechos verificados, sin contenido:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, actor, type, payload FROM bridge.event
WHERE type IN ('secret_rejected', 'memory_rejected') AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Reconstruir una conversación:

```sql
BEGIN READ ONLY;
SELECT e.* FROM bridge.event e JOIN bridge.task t ON t.id = e.task_id
WHERE t.root_id = '00000000-0000-0000-0000-000000000000' ORDER BY e.id;
ROLLBACK;
```

## Rotar claves

Toda rotación requiere la aprobación de Lucas. En Vercel, un cambio de variable toma efecto al volver a desplegar.

- **Clave de un agente:** generar con `openssl rand -hex 32`, actualizar el JSON completo de `BRIDGE_AGENT_KEYS` y desplegar, y actualizar la clave en el cliente. No hay solapamiento: el agente recibe 401 hasta tener la nueva. La clave de `grok` también va en la tarjeta segura de Grok Bot.
- **`GROK_WEBHOOK_KEY`:** regenerar la key en la routine de Grok Bot, actualizar la variable y desplegar. Si la URL cambia, también `GROK_WEBHOOK_URL`. No hay solapamiento: entre los dos pasos el webhook rechaza los envíos, y la cola los reintenta con backoff. **Para no gastar intentos ni disparar el cortacircuito**, antes de empezar pausa el adaptador y al terminar reanúdalo:

  ```sql
  INSERT INTO bridge.adapter_pause (adapter, paused_until, reason) VALUES ('grok', now() + interval '15 minutes', 'rotation')
  ON CONFLICT (adapter) DO UPDATE SET paused_until = EXCLUDED.paused_until, reason = EXCLUDED.reason;
  -- Al terminar. UPDATE, no DELETE: sin la fila, los intentos anteriores vuelven a contar.
  UPDATE bridge.adapter_pause SET paused_until = now() WHERE adapter = 'grok';
  ```

- **`CRON_SECRET`:** cambiar la variable y desplegar, y actualizar `bridge_cron_secret` con `vault.update_secret`. Entre los dos pasos, el cron recibe 401 y las tareas esperan: nada se pierde.
- **Rol `bridge_app`:** en `psql` con la URL de administrador, `\password bridge_app`. Luego actualizar `DATABASE_URL` en Vercel y en `.env.local`, y desplegar.
- **Rol `postgres`:** cambiarla en el dashboard de Supabase y actualizar `.env.local`. Vercel no la usa.

## Backup

`psql` y `pg_dump` rechazan el parámetro `uselibpqcompat`, y `pg_dump` debe ser de la versión 17 o mayor porque el servidor es 17. La 16 instalada hoy en el Mac aborta: instala con `brew install postgresql@17` y usa la ruta completa, sin iniciar el servicio. El dump tiene toda la memoria de los agentes, así que va cifrado y fuera del repo:

```sh
export LIBPQ_URL="$(node --env-file=.env.local -p "const u = new URL(process.env.ADMIN_DATABASE_URL); u.searchParams.delete('uselibpqcompat'); u.href")"
mkdir -p -m 700 ~/agent-bridge-backups
/opt/homebrew/opt/postgresql@17/bin/pg_dump -d "$LIBPQ_URL" --schema=bridge --format=custom --no-owner --file="$HOME/agent-bridge-backups/bridge-$(date +%F).dump"
```

`*.dump` está en `.gitignore` por si acaso. Antes de una migración, comprueba que el archivo existe y no está vacío.

Supabase hace un backup diario automático solo en los planes Pro o superiores, con 7 días en Pro. En Free no hay, y este `pg_dump` tendría que correr a diario para cumplir el PRD. Revisar en Database > Backups.

## Restaurar

**Desde el dashboard (Database > Backups):** reemplaza el proyecto entero y lo deja inaccesible mientras dura. Después, resetear la contraseña de `bridge_app`, porque Supabase no la guarda en los backups, y actualizar `DATABASE_URL`.

**Desde un dump, hacia un proyecto nuevo y dedicado.** Nunca sobre el schema vivo. Con `LIBPQ_URL` apuntando al proyecto nuevo:

```sh
psql -d "$LIBPQ_URL" -c "CREATE ROLE bridge_app LOGIN" -c "ALTER ROLE bridge_app SET search_path = bridge" -c "ALTER ROLE bridge_app SET statement_timeout = '10s'" -c "ALTER ROLE bridge_app SET idle_in_transaction_session_timeout = '15s'"
psql -d "$LIBPQ_URL" -c '\password bridge_app'
/opt/homebrew/opt/postgresql@17/bin/pg_restore -d "$LIBPQ_URL" --no-owner --single-transaction ~/agent-bridge-backups/bridge-AAAA-MM-DD.dump
```

El rol se crea antes porque el dump incluye sus permisos. Para dar por probada la restauración:

1. Comparar la cantidad de filas de `task`, `event` y `fact` con el origen.
2. Desplegar un preview contra el proyecto nuevo y comprobar `/health`, `pnpm db:smoke` y una tarea de prueba.
3. Anotar aquí la fecha y el tiempo que tomó.
