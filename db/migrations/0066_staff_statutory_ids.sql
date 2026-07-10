-- 0066_staff_statutory_ids.sql — UAN (EPF) and ESIC IP number on staff, needed
-- for PF ECR and ESI monthly return exports.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS uan     TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS esi_ip  TEXT;
