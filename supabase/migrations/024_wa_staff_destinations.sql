-- Per-staff destinations: which وجهات this staff is allowed/expected
-- to handle. NULL or empty array → handles all destinations (the
-- existing behavior). Non-empty array → only that subset.
--
-- The admin sets this in the "إدارة المستخدمين" tab. The dashboard's
-- conversations panel uses it to scope what each sales staff sees.
-- It also intersects with wa_routing_rules: auto-routing still prefers
-- a routing-rule match, but if a customer's destination isn't covered
-- by the assigned staff's destinations list the dashboard can flag it.

alter table wa_staff
  add column if not exists destinations text[] default '{}';
