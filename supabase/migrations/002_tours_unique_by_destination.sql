-- تغيير قيد الجولات: من UNIQUE(name) إلى UNIQUE(name, type)
-- لأن نفس اسم الجولة قد يتكرر عبر وجهات مختلفة (تركيا، فيتنام، ...)
ALTER TABLE tours DROP CONSTRAINT IF EXISTS tours_name_key;
ALTER TABLE tours ADD CONSTRAINT tours_name_type_key UNIQUE (name, type);
