-- M2 memory. Additive, on top of 001_core.sql. Run with search_path set to the target schema, as db/migrate.ts does:
-- the functions pin it, because a generated column calls them from any session.

-- Folds what people drop when typing: 'Reunión', 'reunion' and 'REUNION' become one token.
CREATE FUNCTION fact_fold(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS
$$ SELECT translate(lower(t), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun') $$;

-- Stems both languages from the raw text, because the Spanish stemmer needs the accents to find its suffixes
-- ('reservación' and 'reservaciones' share a stem only when accented). The folded lexemes catch accentless input.
CREATE FUNCTION fact_lang_vector(t text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS
$$ SELECT to_tsvector('spanish'::regconfig, t)
       || to_tsvector('english'::regconfig, t)
       || to_tsvector('simple'::regconfig, fact_fold(t)) $$;

-- Key separators become spaces, or the parser reads 'vuelo.madrid' as one hostname token.
CREATE FUNCTION fact_search_vector(k text, v text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS
$$ SELECT setweight(fact_lang_vector(translate(k, '._-:/', '     ')), 'A')
       || setweight(fact_lang_vector(v), 'B') $$;

-- OR across words, so a natural question still finds a fact that lacks some of its words; ts_rank orders the hits.
-- A word that is a stop word in either language is dropped: ts_rank has no IDF, so 'the' would outrank real terms.
-- If that leaves nothing ('son', 'no'), all words are used. The parser handles dates, hostnames and any punctuation,
-- so this function cannot raise a tsquery syntax error.
CREATE FUNCTION fact_search_query(q text) RETURNS tsquery
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path FROM CURRENT AS $$
DECLARE
  w text;
  es tsquery;
  en tsquery;
  content tsquery := '';
  every tsquery := '';
BEGIN
  FOREACH w IN ARRAY regexp_split_to_array(q, '\s+') LOOP
    es := plainto_tsquery('spanish'::regconfig, w);
    en := plainto_tsquery('english'::regconfig, w);
    every := every || es || en || plainto_tsquery('simple'::regconfig, fact_fold(w));
    IF numnode(es) > 0 AND numnode(en) > 0 THEN
      content := content || es || en || plainto_tsquery('simple'::regconfig, fact_fold(w));
    END IF;
  END LOOP;
  RETURN CASE WHEN numnode(content) > 0 THEN content ELSE every END;
END $$;

ALTER TABLE fact ADD COLUMN search tsvector GENERATED ALWAYS AS (fact_search_vector(key, value)) STORED;
CREATE INDEX fact_search ON fact USING gin (search);

-- Every fact has a source event. NOT VALID enforces it on new rows without judging any existing ones.
ALTER TABLE fact ADD CONSTRAINT fact_has_source_event CHECK (source_event_id IS NOT NULL) NOT VALID;

-- Facts are never overwritten. An update can retire a row once, or change trust. Trust changes are for an admin
-- connection: bridge_app gets no such grant below. DELETE stays possible for an admin, to purge a leaked secret.
CREATE FUNCTION fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.namespace, NEW.key, NEW.value, NEW.source_agent, NEW.source_event_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.namespace, OLD.key, OLD.value, OLD.source_agent, OLD.source_event_id, OLD.created_at)
     OR (OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION 'fact is immutable: supersede it with a new row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fact_no_rewrite BEFORE UPDATE ON fact FOR EACH ROW EXECUTE FUNCTION fact_immutable();

-- The app can write provenance and retire rows, but cannot name trust, so nothing it does can mark a fact verified.
-- Conditional because the role does not exist in every database that runs this file.
DO $$
BEGIN
  IF to_regrole('bridge_app') IS NOT NULL THEN
    REVOKE INSERT, UPDATE ON fact FROM bridge_app;
    GRANT INSERT (id, namespace, key, value, source_agent, source_event_id) ON fact TO bridge_app;
    GRANT UPDATE (superseded_by) ON fact TO bridge_app;
  END IF;
END $$;
