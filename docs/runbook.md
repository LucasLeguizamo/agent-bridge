# Runbook de agent-bridge

Un contenedor en Fly.io, con Postgres en el proyecto dedicado de Supabase. Nunca el de FreeTicket.
Desplegar, migrar producción, rotar claves o cambiar DNS requiere la aprobación explícita de Lucas.

**Pendiente antes de M5:** la restauración de abajo está escrita pero no probada. El PRD exige una prueba real.

**Alertas:** hoy son solo filas en `event`. Nadie recibe un aviso, y si el proceso cae no se escribe ninguna. Hay que revisarlas a mano.

## Variables de entorno

| Dónde | Variables |
|---|---|
| Secretos de Fly | `DATABASE_URL`, `BRIDGE_AGENT_KEYS`, `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY` |
| `fly.toml` | `PORT` |
| Solo en `.env.local`, nunca en el host | `ADMIN_DATABASE_URL`, `BRIDGE_DB_PASSWORD`, `TEST_DATABASE_URL` |

Sin las dos de Grok, el adaptador no carga y sus tareas quedan en cola. Si `.env.example` suma variables nuevas de un adaptador, también van a los secretos de Fly.

## Desplegar

1. Hacer un backup (abajo).
2. Aplicar las migraciones pendientes: `pnpm db:migrate`. Cada archivo corre en una transacción y queda en `bridge.schema_migration`.
3. Solo la primera vez, dar de alta a los agentes. `bridge.agent` está vacía, y sin una fila cada agente recibe 403. Los ids deben coincidir con `BRIDGE_AGENT_KEYS`:

   ```sql
   INSERT INTO bridge.agent (id, adapter) VALUES ('grok', 'grok'), ('claude', 'http'), ('instinct', 'email')
   ON CONFLICT (id) DO NOTHING;
   ```

4. Solo la primera vez: `fly apps create agent-bridge`, y cargar los secretos sin dejarlos en el historial de la shell, desde un archivo `NOMBRE=valor` fuera del repo:
   `fly secrets import --stage < archivo`. Después, borrar el archivo.
5. `fly deploy --remote-only --ha=false`. Crea una sola máquina y construye en Fly, sin Docker local.
6. Verificar:
   - `curl -fsS https://agent-bridge.fly.dev/health` responde `{"status":"ok"}`.
   - `curl -s -o /dev/null -w '%{http_code}' https://agent-bridge.fly.dev/tasks/x` responde `401`.
   - `fly status`, `fly checks list` y `fly logs` no muestran errores.

Reglas para migraciones nuevas: `db/NNN_nombre.sql`, sin nombres de schema escritos a mano, sin `BEGIN` ni `COMMIT`, y con sus propios `GRANT` a `bridge_app`.

## Rollback

1. `fly releases --image` para ver las imágenes anteriores.
2. `fly deploy --image registry.fly.io/agent-bridge:<tag> --ha=false`.

Esto no revierte secretos, `fly.toml` ni migraciones. Las migraciones van solo hacia adelante: para deshacer una, escribí otra o restaurá un backup.

## Reiniciar o detener

- Reiniciar: `fly machine restart <id>`. El id sale de `fly status`.
- Detener todo: `fly machine stop <id>`. Volver a levantar: `fly machine start <id>`.
- Si la máquina cae junto con su host, Fly no la mueve sola: `fly deploy --remote-only --ha=false` o `fly machine clone <id>`.

## Kill switch

Se corre con `psql` y la URL de administrador. Toma efecto sin reiniciar.

Apagar un agente. Su API responde 403 y el dispatcher deja de entregarle y de entregar lo suyo. Una entrega en curso termina, y los plazos siguen venciendo.

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

Pausar un par de agentes una hora. `agent_a` es el menor de los dos ids en orden alfabético:

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

Alertas del último día. El campo `alert` vale `deadline_exceeded`, `delivery_exhausted` o `pair_paused`:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload->>'alert' AS alert, payload
FROM bridge.event WHERE type = 'alert' AND created_at > now() - interval '1 day' ORDER BY id DESC;
ROLLBACK;
```

Cola atascada. No genera una fila de alerta, hay que consultarla. Incluye las tareas de un agente sin adaptador cargado o apagado:

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
ROLLBACK;
```

Fallos de entrega. Los errores de correo caerán aquí cuando exista el adaptador de M3:

```sql
BEGIN READ ONLY;
SELECT created_at, task_id, payload FROM bridge.event
WHERE type = 'delivery_failed' AND created_at > now() - interval '1 day' ORDER BY id DESC;
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

Toda rotación requiere la aprobación de Lucas. Fly reinicia la máquina al cambiar un secreto.

- **Clave de un agente:** generar con `openssl rand -hex 32`, actualizar el JSON completo de `BRIDGE_AGENT_KEYS` con `fly secrets import`, y actualizar la clave en el cliente. No hay solapamiento: el agente recibe 401 hasta tener la nueva.
- **Rol `bridge_app`:** en `psql` con la URL de administrador, `\password bridge_app`. Luego actualizar `DATABASE_URL` en Fly y en `.env.local`.
- **Rol `postgres`:** cambiarla en el dashboard de Supabase y actualizar `.env.local`. El host no la usa.

## Backup

Las herramientas de `psql` rechazan el parámetro `uselibpqcompat`, y `pg_dump` debe ser de la versión 17 o mayor porque el servidor es 17. La 16 instalada hoy en el Mac aborta. Instalar con `brew install postgresql@17` y usar `/opt/homebrew/opt/postgresql@17/bin/`, sin iniciar el servicio.

```sh
export LIBPQ_URL="$(node --env-file=.env.local -p "const u = new URL(process.env.ADMIN_DATABASE_URL); u.searchParams.delete('uselibpqcompat'); u.href")"
pg_dump -d "$LIBPQ_URL" --schema=bridge --format=custom --no-owner --file="bridge-$(date +%F).dump"
```

El dump tiene toda la memoria de los agentes: se guarda cifrado y fuera del repo.

Supabase hace un backup diario automático solo en los planes Pro o superiores, con 7 días en Pro. En Free no hay, y este `pg_dump` tendría que correr a diario para cumplir el PRD. Revisar en Database > Backups.

## Restaurar

**Desde el dashboard (Database > Backups):** reemplaza el proyecto entero y lo deja inaccesible mientras dura. Después, resetear la contraseña de `bridge_app`, porque Supabase no la guarda en los backups, y actualizar `DATABASE_URL`.

**Desde un dump, hacia un proyecto nuevo y dedicado.** Nunca sobre el schema vivo. Con `LIBPQ_URL` apuntando al proyecto nuevo:

```sh
psql -d "$LIBPQ_URL" -c "CREATE ROLE bridge_app LOGIN" -c "ALTER ROLE bridge_app SET search_path = bridge"
psql -d "$LIBPQ_URL" -c '\password bridge_app'
pg_restore -d "$LIBPQ_URL" --no-owner --single-transaction bridge-AAAA-MM-DD.dump
```

El rol se crea antes porque el dump incluye sus permisos. Para dar por probada la restauración:

1. Comparar la cantidad de filas de `task`, `event` y `fact` con el origen.
2. Levantar el servicio contra el proyecto nuevo y comprobar `/health` y una tarea de prueba.
3. Anotar aquí la fecha y el tiempo que tomó.
