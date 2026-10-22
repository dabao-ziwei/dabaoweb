BEGIN IMMEDIATE;
UPDATE feedback SET
 draft_json=json_remove(draft_json,'$.consent','$.consentNote','$.consentMediaId','$.consentAt','$.consentBy'),
 published_json=CASE WHEN published_json IS NULL THEN NULL ELSE
   json_remove(published_json,'$.consent','$.consentNote','$.consentMediaId','$.consentAt','$.consentBy') END;
UPDATE versions SET snapshot_json=json_set(snapshot_json,'$.feedback',json((
 SELECT json_group_array(json(json_remove(value,'$.consent','$.consentNote','$.consentMediaId','$.consentAt','$.consentBy')))
 FROM json_each(versions.snapshot_json,'$.feedback')
)));
UPDATE audit_log SET
 before_json=CASE WHEN before_json IS NULL THEN NULL ELSE
   json_remove(before_json,'$.consent','$.consentNote','$.consentMediaId','$.consentAt','$.consentBy') END,
 after_json=CASE WHEN after_json IS NULL THEN NULL ELSE
   json_remove(after_json,'$.consent','$.consentNote','$.consentMediaId','$.consentAt','$.consentBy') END
 WHERE kind='feedback';
INSERT INTO schema_migrations(version,applied_at) VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
